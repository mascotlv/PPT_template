import {categories,products} from './preview-data';

export async function previewRequest(path:string, method:string):Promise<unknown> {
 const url=new URL(path,'https://preview.invalid');
 if(url.pathname==='/analytics/events') return {ok:true};
 if(method!=='GET') throw Object.assign(new Error('This feature requires a backend.'),{code:'FRONTEND_PREVIEW'});
 if(url.pathname==='/session') return {previewMode:true,customer:null,admin:null,checkoutEnabled:false,brand:{contact:'',nameZh:'模板工坊',nameEn:'Template Workshop'},storefrontText:{}};
 if(url.pathname==='/categories') return categories;
 if(url.pathname==='/products') {
   const currency=url.searchParams.get('currency')||'CNY';
   const search=(url.searchParams.get('search')||'').toLowerCase();
   const cost=(product:typeof products[number])=>product.prices.find(p=>p.currency===currency)?.amount||0;
   const divisor=['JPY','KRW'].includes(currency)?1:100;
   let rows=products.filter(product=>(!url.searchParams.get('category')||product.category.id===url.searchParams.get('category'))&&(!search||Object.values(product.translations).some(t=>(t.title+' '+t.description).toLowerCase().includes(search)))&&(!url.searchParams.get('minPrice')||cost(product)/divisor>=Number(url.searchParams.get('minPrice')))&&(!url.searchParams.get('maxPrice')||cost(product)/divisor<=Number(url.searchParams.get('maxPrice'))));
   if(url.searchParams.get('priceSort')==='asc') rows=rows.slice().sort((a,b)=>cost(a)-cost(b));
   if(url.searchParams.get('priceSort')==='desc') rows=rows.slice().sort((a,b)=>cost(b)-cost(a));
   return rows;
 }
 if(url.pathname.startsWith('/products/')) {
   const product=products.find(p=>p.slug===decodeURIComponent(url.pathname.slice('/products/'.length)));
   if(product) return product;
 }
 if(url.pathname==='/orders') return [];
 throw Object.assign(new Error('This feature requires a backend.'),{code:'FRONTEND_PREVIEW'});
}
