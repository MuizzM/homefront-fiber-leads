export interface CnsRangePlan {
  start: number; end: number; inclusive: boolean; candidateCount: number;
  valid: boolean; error: "invalid_number"|"below_lower_limit"|"above_upper_limit"|"reversed"|"job_limit"|null;
}

export function planCnsRange(input:{start:number;end:number;inclusive?:boolean;lowerLimit?:number;upperLimit:number;jobSizeLimit:number}):CnsRangePlan{
  const inclusive=input.inclusive??true,start=Math.floor(Number(input.start)),end=Math.floor(Number(input.end));
  let error:CnsRangePlan["error"]=null;
  if(!Number.isFinite(start)||!Number.isFinite(end))error="invalid_number";
  else if(start<(input.lowerLimit??1))error="below_lower_limit";
  else if(end>input.upperLimit)error="above_upper_limit";
  else if(end<start||(!inclusive&&end===start))error="reversed";
  const candidateCount=error?0:Math.max(0,end-start+(inclusive?1:0));
  if(!error&&candidateCount>input.jobSizeLimit)error="job_limit";
  return {start,end,inclusive,candidateCount,valid:error===null,error};
}

export function formatCnsIdentifier(environment:string,controlNumber:number,paddingWidth=7):string{
  return `${environment.trim().toUpperCase()}${String(Math.max(0,Math.floor(controlNumber||0))).padStart(paddingWidth,"0")}`;
}
