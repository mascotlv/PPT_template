const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {BrowserSession}=require('./integration.cjs');
const cookies=b=>Object.entries(b.jar).map(([k,v])=>`${k}=${v}`).join('; ');
async function events(base,b,path){
  const abort=new AbortController(),response=await fetch(base+'/api/v1'+path,{headers:{Cookie:cookies(b)},signal:abort.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  async function next(){const timeout=setTimeout(()=>abort.abort(),5000);try{while(true){const end=buffer.indexOf('\n\n');if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').find(line=>line.startsWith('data:'));if(data)return JSON.parse(data.slice(5));continue;}const chunk=await reader.read();if(chunk.done)return null;buffer+=decoder.decode(chunk.value,{stream:true}).replaceAll('\r','');}}finally{clearTimeout(timeout);}}
  return {next,close:()=>abort.abort()};
}
exports.run=async(ctx,record)=>{
  const {base,config,db,buyer,other,admin,product,primary}=ctx;
  await record('N11','当前币种价格升降序、闭区间、零小数币种和非法范围',async()=>{
    for(const currency of ['CNY','USD','JPY']){
      const list=(await buyer.call('/products?currency='+currency+'&priceSort=asc')).data,amount=p=>p.prices.find(v=>v.currency===currency).amount;
      assert.ok(list.length>=3);assert.deepEqual(list.map(amount),list.map(amount).sort((a,b)=>a-b));
      const desc=(await buyer.call('/products?currency='+currency+'&priceSort=desc')).data;assert.deepEqual(desc.map(amount),list.map(amount).reverse());
      const value=amount(list[0])/(currency==='JPY'?1:100),filtered=await buyer.call('/products?'+new URLSearchParams({currency,minPrice:String(value),maxPrice:String(value)}));assert.equal(filtered.status,200);assert.ok(filtered.data.length>0);assert.ok(filtered.data.every(p=>amount(p)===amount(list[0])));
    }
    for(const query of ['minPrice=90&maxPrice=1','minPrice=-1','currency=JPY&minPrice=1.5','priceSort=bad'])assert.equal((await buyer.call('/products?'+query)).status,400);
  });
  await record('N12','反馈默认待解决，已解决/忽略筛选，备忘录和售后角色隔离',async()=>{
    const ticket=await buyer.call('/orders/'+primary.id+'/support','POST',{content:'新的订单问题，请协助处理'});assert.equal(ticket.status,201);assert.equal(ticket.data.status,'OPEN');assert.equal(ticket.data.source,'CUSTOMER');
    assert.equal((await admin.call('/support/'+ticket.data.id,'PATCH',{status:'IGNORED'})).status,404);
    assert.equal((await admin.call('/admin/support/'+ticket.data.id,'PATCH',{status:'IGNORED',reply:'已核对，无需继续处理'})).status,200);
    assert.ok((await admin.call('/admin/support?status=IGNORED')).data.some(v=>v.id===ticket.data.id));
    assert.equal((await admin.call('/admin/support/'+ticket.data.id,'PATCH',{status:'RESOLVED',content:'改写客户原文'})).status,400);
    const memo=await admin.call('/admin/support','POST',{title:'开店备忘：商品更新',content:'下周整理产品封面'});assert.equal(memo.status,201);assert.equal(memo.data.orderId,null);assert.equal(memo.data.status,'OPEN');assert.equal(memo.data.source,'MEMO');
    const support=await new BrowserSession(base,config).init();await support.login(ctx.support);assert.ok(!(await support.call('/admin/support')).data.some(v=>v.id===memo.data.id));assert.equal((await support.call('/admin/support','POST',{title:'无权限',content:'不可新增私人备忘录'})).status,403);assert.equal((await support.call('/admin/support/'+memo.data.id,'PATCH',{status:'RESOLVED'})).status,403);
    assert.equal((await admin.call('/admin/support/'+memo.data.id,'PATCH',{status:'RESOLVED',reply:'已完成'})).status,200);assert.ok((await admin.call('/admin/support?status=RESOLVED&source=MEMO')).data.some(v=>v.id===memo.data.id));
  });
  await record('N13','双向聊天、买家隔离、重试幂等、输入限制与卖家回复审计',async()=>{
    const stranger=await new BrowserSession(base,config).init();await stranger.register(db,'chat-other@example.test');const first=(await buyer.call('/chat')).data,second=(await stranger.call('/chat')).data;assert.notEqual(first.id,second.id);
    const input={content:'<script>仅作为文字展示</script> 你好商家',clientId:randomUUID()},sent=await buyer.call('/chat/messages','POST',input);assert.equal(sent.status,201);assert.equal((await buyer.call('/chat/messages','POST',input)).data.id,sent.data.id);assert.equal((await buyer.call('/chat/messages','POST',{...input,content:'重复标识但不同内容'})).status,409);
    assert.equal((await stranger.call('/chat')).data.messages.length,0);assert.equal((await buyer.call('/admin/chat/'+second.id+'/messages')).status,401);assert.equal((await stranger.call('/chat?before='+sent.data.id)).status,400);
    assert.equal((await buyer.call('/chat/messages','POST',{content:'x'.repeat(2001),clientId:randomUUID()})).status,400);
    const rows=(await admin.call('/admin/chat')).data;assert.equal(rows.find(v=>v.id===first.id).unread,true);
    const reply=await admin.call('/admin/chat/'+first.id+'/messages','POST',{content:'您好，已收到您的咨询',clientId:randomUUID()});assert.equal(reply.status,201);assert.equal(reply.data.sender,'SELLER');assert.ok(!('actorId' in reply.data));assert.ok(!('customerId' in reply.data));const seen=(await db.chatConversation.findUnique({where:{id:first.id}})).buyerSeenAt;for(let i=0;i<2;i++)assert.equal((await buyer.call('/chat/unread')).data.unreadCount,1);assert.equal((await stranger.call('/chat/unread')).data.unreadCount,0);assert.equal((await db.chatConversation.findUnique({where:{id:first.id}})).buyerSeenAt.getTime(),seen.getTime());assert.equal((await buyer.call('/chat')).data.messages.at(-1).content,reply.data.content);assert.equal((await buyer.call('/chat/unread')).data.unreadCount,0);assert.ok(await db.audit.findFirst({where:{action:'CHAT_REPLY',objectId:first.id}}));
  });
  await record('N13b','聊天附件上传、随消息存储、下载字节一致、类型与权限校验',async()=>{
    const {createHash}=require('node:crypto');
    const stranger=await new BrowserSession(base,config).init();await stranger.register(db,'attach-other@example.test');
    const convo=(await buyer.call('/chat')).data;
    // 1) Upload a PNG and a "document" (small text file); both must validate and stage under the owner prefix.
    const pngBytes=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100'+'05fe02fea7'+'0000000049454e44ae426082','hex');
    const png=new FormData();png.append('file',new Blob([pngBytes],{type:'image/png'}),'截图 中文 😀.png');
    const uploaded=await buyer.call('/chat/attachments','POST',png);assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));assert.match(uploaded.data.key,new RegExp('^chat/'));assert.equal(uploaded.data.filename,'截图 中文 😀.png');assert.equal(uploaded.data.kind,'IMAGE');assert.equal(uploaded.data.size,pngBytes.length);assert.equal(uploaded.data.sha256,createHash('sha256').update(pngBytes).digest('hex'));
    const doc=new FormData();doc.append('file',new Blob([Buffer.from('hello attachment')],{type:'text/plain'}),'notes.txt');
    const docUpload=await buyer.call('/chat/attachments','POST',doc);assert.equal(docUpload.status,201);assert.equal(docUpload.data.kind,'FILE');
    // 2) Reject a disallowed extension and a mismatched MIME.
    const bad=new FormData();bad.append('file',new Blob([Buffer.from('x')],{type:'application/x-msdownload'}),'evil.exe');assert.equal((await buyer.call('/chat/attachments','POST',bad)).status,400);
    const spoof=new FormData();spoof.append('file',new Blob([pngBytes],{type:'text/plain'}),'fake.png');assert.equal((await buyer.call('/chat/attachments','POST',spoof)).status,400);
    // 3) Send an image-only message, then a message with text + document.
    const imageOnly=await buyer.call('/chat/messages','POST',{content:'',clientId:randomUUID(),attachment:uploaded.data});assert.equal(imageOnly.status,201,JSON.stringify(imageOnly.data));assert.equal(imageOnly.data.attachment.kind,'IMAGE');
    const withText=await buyer.call('/chat/messages','POST',{content:'这是说明文件',clientId:randomUUID(),attachment:docUpload.data});assert.equal(withText.status,201);assert.equal(withText.data.content,'这是说明文件');assert.equal(withText.data.attachment.filename,'notes.txt');
    // 4) History must carry the attachment metadata for both parties.
    const history=(await buyer.call('/chat')).data;const mine=history.messages.find(m=>m.id===imageOnly.data.id);assert.ok(mine.attachment);assert.equal(mine.attachment.kind,'IMAGE');
    const sellerView=(await admin.call('/admin/chat/'+convo.id+'/messages')).data;assert.ok(sellerView.messages.some(m=>m.id===withText.data.id&&m.attachment&&m.attachment.filename==='notes.txt'));
    // 5) Download returns the exact bytes with safe headers.
    const dl=await fetch(base+'/api/v1/chat/attachments/'+imageOnly.data.id,{headers:{Cookie:cookies(buyer)}});assert.equal(dl.status,200);assert.equal(dl.headers.get('content-type'),'image/png');assert.equal(dl.headers.get('x-content-type-options'),'nosniff');assert.equal(createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex'),uploaded.data.sha256);
    // 6) A different customer cannot download or probe someone else's attachment.
    assert.equal((await stranger.call('/chat/attachments/'+imageOnly.data.id)).status,404);
    // 7) An attachment key owned by another user is rejected at send time.
    assert.equal((await stranger.call('/chat/messages','POST',{content:'',clientId:randomUUID(),attachment:uploaded.data})).status,400);
    // 8) Empty message with no attachment is still rejected.
    assert.equal((await buyer.call('/chat/messages','POST',{content:'',clientId:randomUUID()})).status,400);
    // 9) The seller can attach files too — the channel is bidirectional.
    // Both directions must preserve Unicode filenames end to end.
    const priced=new FormData();priced.append('file',new Blob([Buffer.from('%PDF-1.4 quote')],{type:'application/pdf'}),'报价单-2026.pdf');
    const sellerUpload=await admin.call('/admin/chat/attachments','POST',priced);
    assert.equal(sellerUpload.status,201,JSON.stringify(sellerUpload.data));
    assert.match(sellerUpload.data.key,/^chat\//);
    assert.equal(sellerUpload.data.kind,'FILE');
    const sellerReply=await admin.call('/admin/chat/'+convo.id+'/messages','POST',{content:'报价单见附件',clientId:randomUUID(),attachment:sellerUpload.data});
    assert.equal(sellerReply.status,201,JSON.stringify(sellerReply.data));
    assert.equal(sellerReply.data.sender,'SELLER');
    assert.equal(sellerReply.data.attachment.filename,'报价单-2026.pdf');
    // 10) The buyer can see and download what the seller sent.
    assert.equal((await buyer.call('/chat/unread')).data.unreadCount,1);
    const buyerHistory=(await buyer.call('/chat')).data;
    assert.equal((await buyer.call('/chat/unread')).data.unreadCount,0);
    assert.ok(buyerHistory.messages.some(m=>m.id===sellerReply.data.id&&m.attachment&&m.attachment.filename==='报价单-2026.pdf'));
    const sellerDl=await fetch(base+'/api/v1/chat/attachments/'+sellerReply.data.id,{headers:{Cookie:cookies(buyer)}});
    assert.equal(sellerDl.status,200);
    assert.equal(sellerDl.headers.get('content-type'),'application/pdf');
    assert.match(sellerDl.headers.get('content-disposition')||'',/attachment; filename\*=UTF-8''/);assert.ok(sellerDl.headers.get('content-disposition').includes(encodeURIComponent('报价单-2026.pdf')));
    assert.equal(Buffer.from(await sellerDl.arrayBuffer()).toString(),'%PDF-1.4 quote');
    // 11) The admin download route serves the same bytes back to the seller.
    const adminDl=await fetch(base+'/api/v1/admin/chat/attachments/'+sellerReply.data.id,{headers:{Cookie:cookies(admin)}});
    assert.equal(adminDl.status,200);
    assert.equal(Buffer.from(await adminDl.arrayBuffer()).toString(),'%PDF-1.4 quote');
    // 12) A buyer-owned key cannot be smuggled into an admin message, and vice versa.
    assert.equal((await admin.call('/admin/chat/'+convo.id+'/messages','POST',{content:'',clientId:randomUUID(),attachment:uploaded.data})).status,400);
  });
  await record('N13c','昵称头像保存、准确未读条数、页面语言同步和自动翻译缓存及隔离',async()=>{
    const http=require('node:http');let requests=0,lastPayload;
    const service=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;lastPayload=JSON.parse(raw);requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({translatedText:'Hello merchant'}));});
    await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+service.address().port+'/translate',profile=(await buyer.call('/session')).data.customer;
    const avatar='data:image/png;base64,iVBORw0KGgo=';
    const merchantBefore=(await admin.call('/admin/account')).data;
    try {
      let saved=await buyer.call('/account/profile','PATCH',{name:profile.name,country:profile.country,language:profile.language,currency:profile.currency,nickname:'顾客小李',avatar});assert.equal(saved.status,200);
      const buyerProfile=(await buyer.call('/session')).data.customer;assert.equal(buyerProfile.nickname,'顾客小李');assert.equal(buyerProfile.name,profile.name);assert.equal(buyerProfile.avatar,avatar);
      saved=await admin.call('/admin/account','PATCH',{nickname:'模板顾问',avatar});assert.equal(saved.status,200);assert.equal((await admin.call('/session')).data.admin.nickname,'模板顾问');
      assert.equal((await buyer.call('/admin/account','PATCH',{nickname:'无权限',avatar:''})).status,401);
      assert.equal((await buyer.call('/chat/preferences','PATCH',{language:'en'})).status,200);assert.equal((await buyer.call('/session')).data.customer.language,'en');
      const conversation=(await buyer.call('/chat')).data;
      await admin.call('/admin/chat/'+conversation.id+'/messages');
      const messages=[];for(let i=0;i<3;i++)messages.push((await buyer.call('/chat/messages','POST',{content:'你好商家测试 '+i,clientId:randomUUID()})).data);
      let row=(await admin.call('/admin/chat')).data.find(v=>v.id===conversation.id);assert.equal(row.unreadCount,3);assert.equal(row.customer.nickname,'顾客小李');
      const history=(await admin.call('/admin/chat/'+conversation.id+'/messages')).data;assert.equal(history.participants.BUYER.nickname,'顾客小李');assert.equal(history.participants.BUYER.language,'en');assert.equal(history.participants.SELLER.nickname,'模板顾问');assert.equal(history.participants.SELLER.language,'zh');assert.equal((await admin.call('/admin/chat')).data.find(v=>v.id===conversation.id).unreadCount,0);
      const stranger=await new BrowserSession(base,config).init();await stranger.register(db,'translation-isolation@example.test');
      const message=messages[0];assert.equal((await stranger.call('/chat/messages/'+message.id+'/translation','POST',{target:'en'})).status,404);
      assert.equal((await buyer.call('/chat/messages/'+message.id+'/translation','POST',{target:'bad'})).status,400);
      assert.equal((await buyer.call('/chat/messages/'+message.id+'/translation','POST',{target:'en'})).data.status,'unconfigured');
      assert.equal((await admin.call('/admin/chat/translation-settings','PATCH',{provider:'libretranslate',url,apiKey:'test-translation-key'})).status,200);
      const settings=(await admin.call('/admin/chat/translation-settings')).data;assert.equal(settings.hasKey,true);assert.ok(!JSON.stringify(settings).includes('test-translation-key'));const stored=(await db.setting.findUnique({where:{key:'chat-translation-config'}})).value;assert.ok(!JSON.stringify(stored).includes('test-translation-key'));
      assert.equal((await buyer.call('/chat/messages/'+message.id+'/translation','POST',{target:'en'})).data.text,'Hello merchant');assert.equal(lastPayload.target,'en');assert.equal(lastPayload.source,'auto');assert.equal(lastPayload.api_key,'test-translation-key');assert.equal(requests,1);
      assert.equal((await admin.call('/admin/chat/messages/'+message.id+'/translation','POST',{target:'en'})).data.text,'Hello merchant');assert.equal(requests,1);
      await admin.call('/admin/chat/translation-settings','PATCH',{provider:'libretranslate',url,apiKey:''});assert.equal((await admin.call('/admin/chat/translation-settings')).data.hasKey,true);
      assert.equal((await admin.call('/admin/chat/translation-settings','PATCH',{provider:'libretranslate',url:'file:///etc/passwd',apiKey:''})).status,400);
    } finally {
      await db.setting.deleteMany({where:{key:'chat-translation-config'}});
      await admin.call('/admin/account','PATCH',{nickname:merchantBefore.nickname,avatar:merchantBefore.avatar});
      await buyer.call('/chat/preferences','PATCH',{language:profile.language});
      await new Promise(resolve=>service.close(resolve));
    }
  });
  await record('N14','实际 SSE 推送双向新消息、会话撤销后连接关闭',async()=>{
    const customerStream=await events(base,buyer,'/chat/stream'),sellerStream=await events(base,admin,'/admin/chat/stream');
    try{const c0=await customerStream.next(),s0=await sellerStream.next();const conversation=(await buyer.call('/chat')).data;await buyer.call('/chat/messages','POST',{content:'实时推送客户消息',clientId:randomUUID()});const sellerEvent=await sellerStream.next();assert.notEqual(sellerEvent.revision,s0.revision);await customerStream.next();await admin.call('/admin/chat/'+conversation.id+'/messages','POST',{content:'实时推送商家回复',clientId:randomUUID()});const customerEvent=await customerStream.next();assert.notEqual(customerEvent.revision,c0.revision);assert.ok(!JSON.stringify(customerEvent).includes('实时推送'));}finally{customerStream.close();sellerStream.close();}
    const disposable=await new BrowserSession(base,config).init();await disposable.register(db,'stream-close@example.test');await disposable.call('/chat');const stream=await events(base,disposable,'/chat/stream');try{await stream.next();await disposable.call('/account/logout','POST',{});assert.equal(await stream.next(),null);}finally{stream.close();}
  });
  await record('N15','聊天历史分页不重叠，读取不改变消息修订时间',async()=>{
    const convo=(await buyer.call('/chat')).data,at=(await db.chatConversation.findUniqueOrThrow({where:{id:convo.id}})).updatedAt;
    const customerId=(await db.customer.findUniqueOrThrow({where:{email:'buyer@example.test'}})).id;await db.chatMessage.createMany({data:Array.from({length:55},(_,i)=>({conversationId:convo.id,sender:'BUYER',actorId:customerId,content:'分页内容 '+i,clientId:randomUUID(),createdAt:new Date(Date.now()-100000+i*1000)}))});
    const history=(await buyer.call('/chat')).data;assert.equal(history.messages.length,50);assert.equal(history.hasMore,true);const earlier=(await buyer.call('/chat?before='+history.before)).data;assert.ok(earlier.messages.length>0);assert.ok(!history.messages.some(v=>earlier.messages.some(e=>e.id===v.id)));assert.equal((await db.chatConversation.findUniqueOrThrow({where:{id:convo.id}})).updatedAt.toISOString(),at.toISOString());
  });
  await record('N16','正常模式拒绝下单与所有付款入口，恢复测试模式及模式审计',async()=>{
    const quote=(await buyer.call('/quotes/'+product.id+'?currency=CNY')).data,pending=await buyer.call('/orders','POST',{productId:product.id,email:'buyer@example.test',currency:'CNY',language:'zh',termsVersion:quote.termsVersion,quoteToken:quote.quoteToken,idempotencyKey:randomUUID()});assert.equal(pending.status,201);
    await admin.reauth(ctx.adminCredentials);const settings=(await admin.call('/admin/settings')).data,input={...settings.brand,...settings.downloadRules};
    try{assert.equal((await admin.call('/admin/settings','PATCH',{...input,storeMode:'normal'})).status,200);assert.equal((await buyer.call('/session')).data.checkoutEnabled,false);assert.equal((await buyer.call('/quotes/'+product.id+'?currency=CNY')).data.checkoutEnabled,false);assert.equal((await buyer.call('/orders','POST',{productId:product.id,email:'buyer@example.test',currency:'CNY',language:'zh',termsVersion:quote.termsVersion,quoteToken:quote.quoteToken,idempotencyKey:randomUUID()})).status,403);for(const route of ['/orders/'+pending.data.id+'/pay','/mock/orders/'+pending.data.id+'/scenario'])assert.equal((await buyer.call(route,'POST',{scenario:'success'})).status,403);const dashboard=(await admin.call('/admin/dashboard')).data;assert.equal(dashboard.summary.ordersCount,0);assert.deepEqual(dashboard.orders,[]);assert.deepEqual(dashboard.refunds,[]);}
    finally{assert.equal((await admin.call('/admin/settings','PATCH',{...input,storeMode:'test'})).status,200);}
    assert.equal((await buyer.call('/orders/'+pending.data.id+'/pay','POST',{})).status,201);assert.ok(await db.audit.findFirst({where:{action:'STORE_MODE_CHANGE'}}));assert.equal(Object.keys((await admin.call('/admin/dashboard')).data.summary).length,11);
  });
  await record('N17','登录统一错误提示，避免泄露账号与验证步骤',async()=>{
    const visitor=await new BrowserSession(base,config).init();let r=await visitor.call('/account/login','POST',{email:'missing-account@example.test',password:'test-customer-passphrase'});assert.equal(r.status,401);assert.equal(r.data.code,'INVALID_CREDENTIALS');r=await visitor.call('/account/login','POST',{email:'buyer@example.test',password:'wrong-password'});assert.equal(r.data.code,'INVALID_CREDENTIALS');r=await visitor.call('/admin/login','POST',{email:ctx.adminCredentials.email,password:ctx.adminCredentials.password,code:'invalid-code'});assert.equal(r.data.code,'INVALID_CREDENTIALS');assert.equal((await visitor.call('/session')).data.admin,null);
  });
  await record('N18','账号访问控制无需额外口令，匿名仍停留登录且无购买权限',async()=>{
    const {createApp}=require('../dist/app'),server=await createApp({...config,STORE_ACCESS_MODE:'account'});try{await server.app.listen(0,'127.0.0.1');const url=await server.app.getUrl(),anon=await new BrowserSession(url,config).init(false);assert.equal((await anon.call('/session')).data.access,true);assert.equal((await anon.call('/products')).status,401);assert.equal((await anon.call('/openapi')).status,401);const customer=new BrowserSession(url,config);customer.jar={...buyer.jar};delete customer.jar.access;await customer.call('/session');assert.equal((await customer.call('/products')).status,200);assert.equal((await customer.call('/chat')).status,200);assert.equal((await customer.call('/openapi')).status,401);const owner=await new BrowserSession(url,config).init(false);await owner.login(ctx.adminCredentials);assert.equal((await owner.call('/openapi')).status,200);}finally{await server.app.close();await server.db.$disconnect();}
  });
};
