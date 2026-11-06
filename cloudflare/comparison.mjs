export const dateBR=value=>String(value||'').split('-').reverse().join('/');
export const previousLabel=range=>dateBR(range.previousStart)+' a '+dateBR(range.previousEnd);
