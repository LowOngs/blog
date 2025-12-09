
export const esc = (s="") => String(s).replace(/[&<>"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
export const toJsonLd = (obj)=>{ try{return JSON.stringify(obj);}catch{return "{}";} };
export const clean = (html)=> html.replace(/[`]+/g,"").trim();
