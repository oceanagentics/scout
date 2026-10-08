import { Buffer } from 'node:buffer';
import { parseDocument, DomUtils } from 'htmlparser2';
import { prepareDocument } from './octo-documents.js';

export const UNTC='https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=XXI-10&chapter=21&clang=_en';
export const PREPARATION_VERSION='untc-documents-v1';
const classes=node=>(node.attribs?.class??'').split(/\s+/);

// Preserve the publisher's complete treaty-detail region, including the
// participant table, inline declarations and notes. Rows are not findings.
export function prepareUntcDocument(response,{sourceURL}) {
  const url=sourceURL(response.url);
  if(url!==sourceURL(UNTC))throw new Error('Unexpected UNTC document identity');
  if(response.status!=null&&(response.status<200||response.status>=300)||!/text\/html/i.test(response.headers?.['content-type']??'')||
    typeof response.body!=='string'||!/<\/html>(?:\s|<!--[\s\S]*?-->)*$/i.test(response.body))throw new Error('UNTC HTML status/format/integrity unavailable');
  const dom=parseDocument(response.body,{withStartIndices:true,withEndIndices:true});
  const containers=DomUtils.getElementsByTagName('table',dom.children).filter(n=>classes(n).includes('contenttable'));
  const roots=containers.filter(n=>!containers.some(parent=>parent!==n&&parent.startIndex<n.startIndex&&parent.endIndex>n.endIndex));
  if(roots.length!==1)throw new Error('UNTC detail region missing or ambiguous');
  const region=roots[0];
  for(const suffix of ['_tblgrid','_dgDec','_dgNotesAll']){
    const tables=DomUtils.getElementsByTagName('table',region.children).filter(n=>n.attribs.id?.endsWith(suffix));
    if(tables.length!==1)throw new Error('UNTC structural table missing or ambiguous: '+suffix);
    if(suffix==='_tblgrid'&&!DomUtils.getElementsByTagName('tr',tables[0].children).some(n=>classes(n).includes('thead-one')))
      throw new Error('UNTC participant table header boundary unavailable');
  }
  const anchors=new Set(DomUtils.findAll(n=>n.attribs?.name||n.attribs?.id,region.children).flatMap(n=>[n.attribs.name,n.attribs.id]).filter(Boolean));
  for(const a of DomUtils.getElementsByTagName('a',region.children))if(/^#\d+$/.test(a.attribs.href??'')&&!anchors.has(a.attribs.href.slice(1)))
    throw new Error('UNTC referenced footnote anchor missing');
  const start=region.startIndex,end=region.endIndex+1,html=response.body.slice(start,end);
  const prepared=prepareDocument({title:'',html,url});prepared.version=PREPARATION_VERSION;prepared.input='whole-treaty-detail';
  // UNTC marks headers with a row class rather than <th>. Keep those structural
  // headers in continuation context without interpreting their column values.
  const clean=parseDocument(html),headerRows=DomUtils.getElementsByTagName('tr',clean.children).filter(n=>classes(n).includes('thead-one'));
  const headers=headerRows.map(n=>(n.children??[]).filter(c=>['td','th'].includes(c.name)).map(c=>DomUtils.textContent(c).replace(/\s+/g,' ').trim()).join('\t')).join('\n');
  for(const block of prepared.blocks)if(block.tag==='table')block.table_context=[block.table_context,headers].filter(Boolean).join('\n');
  prepared.omissions.push({start,end,reason:'Whole treaty-detail table region prepared; surrounding navigation/form-state framing excluded; exact full response retained'});
  const coverage=prepared.links.map(link=>{
    let target;
    try{
      target=new URL(link.target,url);
      if(target.hash&&sourceURL(target.href)===url)return {...link,relationship:'same-document-anchor',state:'retained',reason:'In-page anchor context retained with the whole detail region'};
      sourceURL(target.href);
      return {...link,state:/\.(?:pdf|xml)(?:$|[?#])/i.test(target.href)?'unsupported':'unfetched',reason:'Linked declaration/annex/copy/support destination not fetched by this source-only adapter'};
    }catch{return {...link,state:'unsupported',reason:'Script/mail/non-HTTPS target retained as source evidence; not executed or fetched'};}
  });
  coverage.push({relationship:'scope',state:'partial',reason:'One complete configured treaty-detail page; linked documents, annexes, attachments, XML copies, translations and archive history remain unfetched'});
  prepared.coverage=coverage;
  return {id:'untc:XXI-10:detail',url,raw:response.body,response,regions:[{start,end}],prepared,coverage};
}

export async function retrieveUntcDocuments({tracker,read,sourceURL,budget,known=[],knownDocuments=[],pending=[],limits={requests:1},now=Date.now}) {
  if(tracker.collector!=='web'||sourceURL(tracker.url)!==sourceURL(UNTC))throw new Error('Unsupported UNTC tracker');
  limits={documents:1,bytes:524288,...limits};
  if(['documents','requests'].some(k=>!Number.isSafeInteger(limits[k])||limits[k]<0)||!Number.isSafeInteger(limits.bytes)||limits.bytes<1||
    !Number.isSafeInteger(budget.requests)||budget.requests<0||!Number.isFinite(budget.deadline))throw new Error('Invalid UNTC retrieval bound');
  const documents=[],responses=[],coverage=[];let requests=0;
  const item={id:'untc:XXI-10:detail',url:sourceURL(UNTC),state:'pending'},ids=new Set([item.id]),urls=new Set([item.url]);
  for(const prior of [...known,...knownDocuments,...pending]){
    for(const id of [prior.id,prior.identity,...prior.ids??[]])if(id!=null)ids.add(String(id));
    for(const url of [prior.url,...prior.urls??[]]){try{urls.add(sourceURL(url));}catch{urls.add(String(url));}}
    const states=[item.pending_state,prior.state,prior.pending_state];
    item.pending_state=states.includes('model-repair')?'model-repair':states.includes('model-pending')?'model-pending':undefined;
    if(prior.last_failure)item.last_failure=prior.last_failure;
  }
  Object.assign(item,{ids:[...ids],urls:[...urls]});
  if(ids.size>1||urls.size>1)Object.assign(item,{state:'failed',reason:'Conflicting known/pending UNTC identity or configured URL; retained without acquisition'});
  else if(!limits.documents||budget.requests>=limits.requests||now()>=budget.deadline){
    Object.assign(item,{state:'deferred',reason:!limits.documents?'UNTC document bound reached':budget.requests>=limits.requests?'UNTC request bound reached':'Collection time limit reached'});
  }else{
    const receipt={requested_url:item.url,state:'failed'},before=budget.requests;responses.push(receipt);requests++;
    try{
      const response=await read(item.url,budget);receipt.response=response;
      if(typeof response.body!=='string'||Buffer.byteLength(response.body)>limits.bytes)throw new Error('UNTC response byte bound');
      if(budget.requests>limits.requests||now()>=budget.deadline)throw Object.assign(new Error('UNTC request/time bound reached after read'),{quota:true});
      const document=prepareUntcDocument(response,{sourceURL});
      if(now()>=budget.deadline)throw Object.assign(new Error('Collection time limit reached during preparation'),{quota:true});
      documents.push(document);coverage.push(...document.coverage);item.state='retained';receipt.state='fetched';delete item.last_failure;
    }catch(error){
      Object.assign(item,{state:error.quota||now()>=budget.deadline?'deferred':'failed',reason:error.message});
      item.last_failure={state:item.state,reason:item.reason};Object.assign(receipt,item.last_failure);
    }finally{if(budget.requests===before)budget.requests++;}
  }
  coverage.push({...item});
  return {documents,responses,coverage,inventory:[item],pending:item.state==='retained'?[]:[item],requests,limits,complete:false};
}
