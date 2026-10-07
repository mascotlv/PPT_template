const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {BrowserSession}=require('./integration.cjs');
exports.check=async function({base,config,db,auth}){
  const saved=config.DEV_AUTH_BYPASS;
  try{
    config.DEV_AUTH_BYPASS=true;
    const first=await new BrowserSession(base,config).init(false),second=await new BrowserSession(base,config).init(false);
    const profile=(await first.call('/session')).data,other=(await second.call('/session')).data;
    assert.equal(profile.developmentAuth,true);assert.equal(profile.customer.verified,true);assert.equal(profile.admin.role,'ADMIN');assert.notEqual(profile.customer.id,other.customer.id);
    assert.equal((await first.call('/admin/products')).status,200);
    const adminSession=await db.session.findUniqueOrThrow({where:{tokenHash:require('../dist/security').hash(first.jar.admin)},include:{admin:true}});
    await db.session.update({where:{id:adminSession.id},data:{reauthAt:null}});
    assert.doesNotThrow(()=>auth.reauth({admin:adminSession}));
    const products=(await first.call('/products')).data,p=products[0];assert.ok(p);
    const quote=(await first.call(`/quotes/${p.id}?currency=CNY`)).data;
    const order=await first.call('/orders','POST',{productId:p.id,email:profile.customer.email,language:'zh',currency:'CNY',quoteToken:quote.quoteToken,idempotencyKey:randomUUID(),termsVersion:'demo-v1'});
    assert.equal(order.status,201,JSON.stringify(order.data));
    assert.equal((await first.call(`/orders/${order.data.id}/pay`,'POST',{})).status,201);
    assert.equal((await first.call(`/orders/${order.data.id}/download`,'POST',{})).status,201);
    assert.equal((await second.call(`/orders/${order.data.id}`)).status,404);
    const chat=await first.call('/chat');assert.equal(chat.status,200);
    assert.equal((await first.call('/chat/messages','POST',{content:'Development chat test',clientId:randomUUID()})).status,201);
    assert.equal((await first.call('/admin/orders/export','POST',{})).status,201);
    assert.equal((await first.call('/admin/categories','POST',{id:'dev-auth-test',nameZh:'开发测试',nameEn:'Development test'})).status,201);
    assert.equal((await first.call('/admin/categories/dev-auth-test','DELETE',{})).status,200);
    config.DEV_AUTH_BYPASS=false;
    assert.ok([401,403].includes((await first.call('/products')).status));
    assert.ok([401,403].includes((await first.call('/admin/dashboard')).status));
  }finally{config.DEV_AUTH_BYPASS=saved;}
};
