// Generic HTTP checks only. The caller supplies evidence of a previous successful read.
export async function checkFreshness(url,{lastSuccessfulCheck=null,fetch:send=fetch,signal=AbortSignal.timeout(15000)}={}){
  const checked=new Date(lastSuccessfulCheck??NaN).getTime(),known=Number.isFinite(checked);
  const response=await send(url,{signal,...(known?{headers:{'If-Modified-Since':new Date(checked).toUTCString()}}:{})});
  const modified=Date.parse(response.headers.get('last-modified')??'');
  const unchanged=known&&(response.status===304||response.status===200&&Number.isFinite(modified)&&modified<=checked);
  if(unchanged)await response.body?.cancel();
  return {response,unchanged};
}
