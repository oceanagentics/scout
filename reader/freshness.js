import {createHash} from 'node:crypto';

// The caller supplies evidence of a previous successful read of this resource.
export async function checkFreshness(url,{lastSuccessfulCheck=null,fetch:send=fetch,signal=AbortSignal.timeout(15000)}={}){
  const checked=new Date(lastSuccessfulCheck??NaN).getTime(),known=Number.isFinite(checked);
  const response=await send(url,{signal,...(known?{headers:{'If-Modified-Since':new Date(checked).toUTCString()}}:{})});
  const modified=Date.parse(response.headers.get('last-modified')??'');
  const unchanged=known&&(response.status===304||response.status===200&&Number.isFinite(modified)&&modified<=checked);
  if(unchanged)await response.body?.cancel();
  return {response,unchanged};
}

export function checkContentFreshness({media_type,content},previousFingerprint=null){
  const fingerprint=createHash('sha256').update(JSON.stringify({media_type,content})).digest('hex');
  return {fingerprint,unchanged:fingerprint===previousFingerprint};
}
