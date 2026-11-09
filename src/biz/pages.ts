/** 三张页面：商家控制台、顾客 H5、mock 收银台；外加可打印小票。无框架、无构建。 */

import type { BizCode, BizOrder, BizSummary } from './store.js';
import type { PackConfig } from '../core/types.js';
import { qrSvg } from './qr.js';

const BASE_CSS = `
:root{--blue:#1677ff;--blue-d:#0e5fd8;--ink:#0f172a;--muted:#64748b;--line:#e6ebf4;--bg:#f5f7fb;--card:#fff;--ok:#0f9d58;--warn:#d97706;--bad:#dc2626}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);line-height:1.6}
button{font:inherit;cursor:pointer;border:none;border-radius:10px}
input,textarea{font:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.muted{color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600}
.btn{background:var(--blue);color:#fff;padding:10px 16px;font-weight:600;transition:.15s}
.btn:hover{background:var(--blue-d)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-ghost{background:#eef4ff;color:var(--blue)}
.btn-ghost:hover{background:#e0ebff}
.btn-danger{background:#fef2f2;color:var(--bad)}
.hide{display:none !important}
`;

function shell(title: string, css: string, body: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${title}</title><style>${BASE_CSS}${css}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}

/* ================================================================== *
 * 商家控制台
 * ================================================================== */

export function consoleHtml(): string {
  const css = `
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;white-space:nowrap}
.brand #who{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{white-space:nowrap}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#1677ff,#5aa0ff);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-weight:800}
.token{display:flex;gap:8px;align-items:center}
.token input{width:220px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:#fff}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:6px 0 22px}
.stat{padding:16px 18px}
.stat b{display:block;font-size:24px;letter-spacing:-.02em}
.stat span{font-size:12px;color:var(--muted)}
.section{margin:26px 0 10px;display:flex;align-items:baseline;justify-content:space-between}
.section h2{font-size:16px;margin:0}
.packs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.pack{padding:18px;display:flex;flex-direction:column;gap:10px}
.pack h3{margin:0;font-size:15px}
.pack .price{font-size:26px;font-weight:700;letter-spacing:-.02em}
.pack .price small{font-size:13px;font-weight:500;color:var(--muted)}
.pack ul{margin:0;padding-left:16px;color:var(--muted);font-size:13px}
.pack .buy{display:flex;gap:8px;margin-top:auto}
.pack .buy input{width:64px;padding:8px;border:1px solid var(--line);border-radius:10px;text-align:center}
.order{padding:16px 18px;margin-bottom:12px}
.order-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.order-title{font-weight:650}
.order-meta{font-size:12px;color:var(--muted)}
.codes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
.code{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:10px}
.code img{width:74px;height:74px;border-radius:6px;background:#fff}
.code .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;letter-spacing:.02em}
.code .meta{font-size:12px;color:var(--muted)}
.code a{color:var(--blue);text-decoration:none}
.code .actions{margin-left:auto;display:flex;flex-direction:column;gap:6px}
.empty{padding:38px;text-align:center;color:var(--muted)}
.merchant{border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.merchant .mname{font-weight:650;display:flex;align-items:center;gap:8px}
.merchant .mmeta{font-size:12px;color:var(--muted)}
.merchant .mactions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.invite-row{display:flex;gap:8px;flex-wrap:wrap}
.invite-row input{flex:1;min-width:190px;padding:9px 12px;border:1px solid var(--line);border-radius:10px}
.linkbox{display:flex;gap:8px;align-items:center}
.linkbox input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12px}
.overlay{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:20}
.modal{background:#fff;border-radius:18px;padding:24px;max-width:380px;width:100%;text-align:center}
.modal svg{width:220px;height:220px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
.toast.show{opacity:1}
@media(max-width:820px){.stats{grid-template-columns:repeat(2,1fr)}.packs{grid-template-columns:1fr}.codes{grid-template-columns:1fr}}
`;
  const body = `
<div class="wrap">
  <div class="top">
    <div class="brand"><span class="logo">外卖</span> AI · 商家台 <span id="who" class="pill hide"></span></div>
    <div class="token"><input id="tok" type="password" placeholder="管理令牌或商家邀请链接"/><button class="btn" id="saveTok">进入</button><button class="btn-ghost hide" id="switchTok" style="padding:7px 12px;background:#fff;border:1px solid var(--line)">切换账号</button></div>
  </div>
  <div id="app" class="hide">
    <div class="stats" id="stats"></div>
    <div class="section"><h2>买次数包</h2><span class="muted" style="font-size:12px">付款后自动出码，可打印贴桌</span></div>
    <div class="packs" id="packs"></div>
    <div id="adminBox" class="hide">
      <div class="section"><h2>邀请商家</h2><span class="muted" style="font-size:12px">生成专属链接，商家打开就是自己的商家台</span></div>
      <div class="card" style="padding:16px 18px">
        <div class="invite-row"><input id="mname" placeholder="商家名称，如：转角咖啡馆"/><button class="btn" id="addMerchant">生成邀请链接</button></div>
        <div id="merchants" style="margin-top:14px"></div>
      </div>
    </div>
    <div class="section"><h2>外卖单码</h2><span class="muted" style="font-size:12px">扫单或输入平台订单号 → 出码并打印 58mm 标签；同一单号重复录入返回原码</span></div>
    <div class="card" style="padding:16px 18px">
      <div class="invite-row"><input id="slipNo" placeholder="平台订单号（外卖单上的数字，可带 #）" autocomplete="off"/><button class="btn" id="bindSlip">出码并打印</button></div>
      <div id="slipResult" class="muted" style="font-size:12px;margin-top:10px"></div>
      <div id="slipList" class="muted" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div class="section"><h2>订单与核销码</h2><button class="btn-ghost" id="refresh" style="padding:6px 12px">刷新</button></div>
    <div id="orders"></div>
  </div>
  <div id="login" class="card empty" style="margin-top:30px">输入管理令牌，或直接打开商家邀请链接。<br/><span style="font-size:12px">管理员看全部商家；商家只看到自己的订单与核销码。</span></div>
</div>
<div id="modal" class="overlay hide"><div class="modal"><h3 id="modalTitle" style="margin-top:0"></h3><div id="modalBody"></div><button class="btn" id="modalClose" style="width:100%;margin-top:14px">关闭</button></div></div>
<div id="toast" class="toast"></div>`;
  const script = `
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=localStorage.getItem('biz_admin_token')||'';
const params=new URLSearchParams(location.search);
const invite=params.get('t');
if(invite){token=invite;localStorage.setItem('biz_admin_token',invite)}
if(params.has('t')){params.delete('t');history.replaceState(null,'',location.pathname+(params.toString()?'?'+params.toString():''))}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}
function setLoggedIn(on){
  $('#switchTok').classList.toggle('hide',!on);
  $('#tok').classList.toggle('hide',on);
  $('#saveTok').classList.toggle('hide',on);
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text);toast('已复制')}
  catch{const el=$('#inviteUrl');if(el){el.select();document.execCommand('copy');toast('已复制')}}
}
async function api(path,opts={}){
  const res=await fetch(path,{...opts,headers:{'content-type':'application/json','X-Admin-Token':token,...(opts.headers||{})}});
  const text=await res.text();let data=null;try{data=JSON.parse(text)}catch{}
  if(res.status===401){setLoggedIn(false);$('#app').classList.add('hide');$('#login').classList.remove('hide');throw new Error('令牌无效')}
  if(!res.ok)throw new Error((data&&data.error&&data.error.message)||text||('HTTP '+res.status));
  return data;
}
function money(n){return '¥'+Number(n).toFixed(2)}
function renderWho(who){
  const el=$('#who');
  el.classList.remove('hide');
  if(who.kind==='admin'){el.textContent='管理员';el.style.background='#eef4ff';el.style.color='#1677ff';$('#adminBox').classList.remove('hide')}
  else{el.textContent=who.merchant.name;el.style.background='#e9f7ef';el.style.color='#0f9d58';$('#adminBox').classList.add('hide')}
}
async function load(){
  const [packs,orders,summary,who]=await Promise.all([api('/biz/api/packs'),api('/biz/api/orders'),api('/biz/api/summary'),api('/biz/api/whoami')]);
  $('#app').classList.remove('hide');$('#login').classList.add('hide');setLoggedIn(true);
  renderWho(who);
  $('#stats').innerHTML=[
    ['累计营收',money(summary.revenueCny)],['已付订单',summary.paidOrderCount+' 单'],
    ['已核销',summary.usesUsed+' 次'],['在用码',summary.activeCodeCount+' 个']
  ].map(([k,v])=>'<div class="card stat"><b>'+v+'</b><span>'+k+'</span></div>').join('');
  $('#packs').innerHTML=packs.packs.map(p=>'<div class="card pack"><h3>'+esc(p.name)+'</h3><div class="price">'+money(p.priceCny)+' <small>/ '+p.uses+' 次</small></div><ul><li>可用模型：'+esc(p.models.join(' / '))+'</li><li>有效期 '+p.validDays+' 天，成功调用才计次</li><li>'+esc(p.description||'')+'</li></ul><div class="buy"><input id="q_'+esc(p.id)+'" type="number" min="1" max="20" value="1"/><button class="btn" data-buy="'+esc(p.id)+'" style="flex:1">购买</button></div></div>').join('');
  const list=orders.orders;
  $('#orders').innerHTML=list.length?list.map(o=>{
    const codes=o.codes||[];
    return '<div class="card order"><div class="order-head"><div><div class="order-title">'+esc(o.packName)+' × '+o.quantity+'</div><div class="order-meta">'+esc(o.merchantName)+' · '+new Date(o.createdAt).toLocaleString()+' · '+o.id+'</div></div><div style="display:flex;gap:8px;align-items:center"><span class="pill" style="background:'+(o.status==='paid'?'#e9f7ef':o.status==='pending'?'#fff7e6':'#fef2f2')+';color:'+(o.status==='paid'?'#0f9d58':o.status==='pending'?'#d97706':'#dc2626')+'">'+(o.status==='paid'?'已支付':o.status==='pending'?'待支付':'已取消')+'</span><span class="order-title">'+money(o.amountCny)+'</span>'+(o.status==='paid'?'<button class="btn-ghost" data-print="'+o.id+'" style="padding:6px 12px">打印小票</button>':'<button class="btn" data-pay="'+o.id+'">去支付</button>')+'</div></div>'+
      (codes.length?'<div class="codes">'+codes.map(c=>{
        const left=Math.max(0,c.usesTotal-c.usesUsed);
        return '<div class="code"><img src="/biz/qr/'+encodeURIComponent(c.code)+'.svg" alt="二维码"/><div><div class="mono">'+esc(c.code)+'</div><div class="meta">剩 '+left+' / '+c.usesTotal+' 次 · '+new Date(c.expiresAt).toLocaleDateString()+' 到期</div><div class="meta">'+(c.revokedAt?'已撤销':'<a href="/s/'+encodeURIComponent(c.code)+'" target="_blank" rel="noopener">'+esc(location.origin+'/s/'+c.code)+'</a>')+'</div></div><div class="actions">'+(c.revokedAt?'':'<button class="btn-danger" data-revoke="'+esc(c.code)+'" style="padding:6px 10px">撤销</button>')+'</div></div>';
      }).join('')+'</div>':'')+'</div>';
  }).join(''):'<div class="card empty">还没有订单。先买一个次数包，付款后自动出码。</div>';
  if(who.kind==='admin')await loadMerchants();
  await loadSlips();
}
async function loadSlips(){
  const r=await api('/biz/api/slips?limit=5');
  const list=r.slips||[];
  $('#slipList').innerHTML=list.length?'最近绑定：'+list.map(s=>esc(s.externalNo)+' → '+esc(s.code)+(s.remaining>0?'（剩 '+s.remaining+' 次）':'（已用完）')).join(' · '):'还没有绑定记录。先买「外卖单码」包，再扫单出码。';
}
async function printLabel(path){
  const res=await fetch(path,{headers:{'X-Admin-Token':token}});
  if(!res.ok)throw new Error('标签页加载失败');
  const html=await res.text();
  const w=window.open('','_blank');
  if(!w)throw new Error('打印窗口被浏览器拦截');
  w.document.write(html);w.document.close();
}
async function bindSlip(){
  const no=$('#slipNo').value.trim();
  if(!no){toast('先扫或输入订单号');return}
  const r=await api('/biz/api/slips/bind',{method:'POST',body:JSON.stringify({externalOrderNo:no})});
  const s=r.slip;
  $('#slipResult').innerHTML='单号 '+esc(s.externalNo)+' → 码 <b>'+esc(s.code)+'</b>（'+s.remaining+'/'+s.usesTotal+' 次，池内还剩 '+r.pool.remaining+' 个）'+(r.reused?' · 已绑过，返回原码':'')+' <button class="btn-ghost" data-label="'+esc(s.labelPath)+'" style="padding:4px 10px;margin-left:6px">打印标签</button>';
  $('#slipNo').value='';
  await loadSlips();
  try{await printLabel(s.labelPath)}catch(e){toast(e.message+'，可点「打印标签」重试')}
}
function merchantRow(m){
  const badge=m.disabledAt?'<span class="pill" style="background:#fef2f2;color:#dc2626">已停用</span>':'<span class="pill" style="background:#e9f7ef;color:#0f9d58">正常</span>';
  return '<div class="merchant"><div><div class="mname">'+esc(m.name)+badge+'</div><div class="mmeta">已付 '+m.paidOrderCount+' 单 · 营收 '+money(m.revenueCny)+' · '+new Date(m.createdAt).toLocaleDateString()+'</div></div><div class="mactions"><button class="btn-ghost" data-mrotate="'+esc(m.id)+'" style="padding:6px 10px">重置链接</button>'+(m.disabledAt?'<button class="btn-ghost" data-menable="'+esc(m.id)+'" style="padding:6px 10px">启用</button>':'<button class="btn-danger" data-mdisable="'+esc(m.id)+'" style="padding:6px 10px">停用</button>')+'</div></div>';
}
async function loadMerchants(){
  const r=await api('/biz/api/merchants');
  $('#merchants').innerHTML=r.merchants.length?r.merchants.map(merchantRow).join(''):'<div class="muted" style="font-size:13px">还没有商家。生成第一条邀请链接后，商家就能用自己的名字买包出码。</div>';
}
function showInvite(name,path){
  const url=location.origin+path;
  $('#modalTitle').textContent='邀请链接 · '+name;
  $('#modalBody').innerHTML='<p class="muted" style="font-size:13px;margin:0 0 10px">把链接发给商家本人，打开就是他的商家台。链接等于登录凭证，对方重置后旧链接会立即失效。</p><div class="linkbox"><input id="inviteUrl" readonly value="'+esc(url)+'"/><button class="btn" id="copyInvite" style="padding:8px 12px">复制</button></div>';
  $('#modal').classList.remove('hide');
  $('#modalClose').onclick=()=>$('#modal').classList.add('hide');
  $('#copyInvite').onclick=()=>copyText(url);
}
async function createMerchant(){
  const name=$('#mname').value.trim();
  if(!name){toast('先填商家名称');return}
  const r=await api('/biz/api/merchants',{method:'POST',body:JSON.stringify({name})});
  $('#mname').value='';
  showInvite(r.merchant.name,r.consolePath);
  await loadMerchants();
}
async function buy(packId){
  const q=Math.max(1,Math.min(20,parseInt($('#q_'+packId).value||'1',10)));
  const r=await api('/biz/api/orders',{method:'POST',body:JSON.stringify({packId,quantity:q})});
  if(r.payment.kind==='redirect'){location.href=r.payment.payUrl+'&return='+encodeURIComponent('/biz');return}
  $('#modalTitle').textContent='支付宝扫码支付 '+money(r.order.amountCny);
  $('#modalBody').innerHTML=(r.payment.payQrSvg||'')+'<p class="muted" style="font-size:12px;word-break:break-all">'+esc(r.payment.payUrl)+'</p>';
  $('#modal').classList.remove('hide');
  const timer=setInterval(async()=>{const s=await api('/biz/api/orders');const o=s.orders.find(x=>x.id===r.order.id);if(o&&o.status==='paid'){clearInterval(timer);$('#modal').classList.add('hide');load()}},3000);
  $('#modalClose').onclick=()=>{clearInterval(timer);$('#modal').classList.add('hide')};
}
document.addEventListener('click',async(ev)=>{
  const t=ev.target;
  if(!(t instanceof HTMLElement))return;
  try{
    if(t.id==='addMerchant')await createMerchant();
    if(t.id==='bindSlip')await bindSlip();
    if(t.dataset.label){try{await printLabel(t.dataset.label)}catch(e){toast(e.message)}}
    if(t.dataset.buy)await buy(t.dataset.buy);
    if(t.dataset.mrotate&&confirm('旧邀请链接会立即失效，确定重置？')){const r=await api('/biz/api/merchants/'+encodeURIComponent(t.dataset.mrotate)+'/rotate',{method:'POST'});showInvite(r.merchant.name,r.consolePath);await loadMerchants()}
    if(t.dataset.mdisable&&confirm('停用后该商家无法登录，确定？')){await api('/biz/api/merchants/'+encodeURIComponent(t.dataset.mdisable)+'/disable',{method:'POST'});toast('已停用');await loadMerchants()}
    if(t.dataset.menable){await api('/biz/api/merchants/'+encodeURIComponent(t.dataset.menable)+'/enable',{method:'POST'});toast('已启用');await loadMerchants()}
    if(t.dataset.revoke&&confirm('撤销后该码立即失效，确定？')){await api('/biz/api/codes/'+encodeURIComponent(t.dataset.revoke)+'/revoke',{method:'POST'});toast('已撤销');load()}
    if(t.dataset.print){
      const res=await fetch('/biz/print/'+t.dataset.print,{headers:{'X-Admin-Token':token}});
      if(!res.ok){toast('打印页加载失败');return}
      const html=await res.text();
      const w=window.open('','_blank');w.document.write(html);w.document.close();
    }
    if(t.dataset.pay){const r=await api('/biz/api/orders/'+t.dataset.pay+'/pay-link');if(r.payment.kind==='redirect')location.href=r.payment.payUrl;else{toast('请用支付宝扫码：'+r.payment.payUrl)}}
  }catch(e){toast(e.message)}
});
$('#modalClose').onclick=()=>$('#modal').classList.add('hide');
$('#switchTok').onclick=()=>{localStorage.removeItem('biz_admin_token');token='';location.href='/biz'};
$('#saveTok').onclick=async()=>{token=$('#tok').value.trim();localStorage.setItem('biz_admin_token',token);try{await load()}catch(e){toast(e.message)}};
$('#refresh').onclick=()=>load().catch(e=>toast(e.message));
$('#slipNo').addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();bindSlip().catch(err=>toast(err.message))}});
if(token){$('#tok').value=token;load().catch(()=>{})}
if(params.has('paid'))history.replaceState(null,'',location.pathname);
`;
  return shell('外卖 AI · 商家台', css, body, script);
}

/* ================================================================== *
 * 顾客 H5
 * ================================================================== */

export function customerHtml(): string {
  const css = `
body{background:#f2f6ff;min-height:100dvh}
.mobile{max-width:560px;margin:0 auto;padding:18px 16px 32px;min-height:100dvh;display:flex;flex-direction:column}
.hero{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 4px 18px}
.hero .name{font-weight:700;font-size:17px}
.hero .sub{font-size:12px;color:var(--muted)}
.remain{background:#fff;border:1px solid var(--line);border-radius:999px;padding:7px 13px;font-size:13px;font-weight:650;white-space:nowrap}
.tabs{display:flex;background:#e8f0fe;border-radius:12px;padding:4px;margin-bottom:12px}
.tab{flex:1;background:transparent;padding:9px;border-radius:9px;color:#3b5b8c;font-weight:600}
.tab.on{background:#fff;color:var(--blue);box-shadow:0 1px 2px rgba(15,23,42,.08)}
.panel{flex:1;display:flex;flex-direction:column;min-height:0}
.chat{flex:1;background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px;overflow-y:auto;min-height:300px;max-height:62dvh;display:flex;flex-direction:column;gap:10px}
.msg{max-width:86%;padding:10px 13px;border-radius:14px;font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--blue);color:#fff;border-bottom-right-radius:4px}
.msg.ai{align-self:flex-start;background:#f1f5fb;border-bottom-left-radius:4px}
.msg.err{align-self:stretch;background:#fef2f2;color:#b91c1c;font-size:13px}
.typing{display:inline-flex;gap:4px;align-items:center}
.typing i{width:5px;height:5px;border-radius:50%;background:#94a3b8;animation:b 1.2s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.chip{background:#fff;border:1px solid var(--line);color:#3b5b8c;padding:7px 11px;border-radius:999px;font-size:12px}
.composer{display:flex;gap:8px;margin-top:10px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:8px}
.composer textarea{flex:1;border:none;outline:none;resize:none;min-height:42px;max-height:120px;padding:8px;background:transparent}
.send{width:46px;border-radius:11px;display:flex;align-items:center;justify-content:center}
.send svg{width:18px;height:18px}
.imagebox{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px;flex:1}
.sizes{display:flex;gap:8px;margin:10px 0}
.size{padding:7px 12px;border-radius:9px;background:#eef4ff;color:#3b5b8c;font-size:12px}
.size.on{background:var(--blue);color:#fff}
.gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
.gallery figure{margin:0;background:#f8fafc;border-radius:12px;overflow:hidden;aspect-ratio:1;display:flex;align-items:center;justify-content:center}
.gallery img{width:100%;height:100%;object-fit:cover}
.gallery .ph{font-size:12px;color:var(--muted);padding:10px;text-align:center}
.empty-ai{text-align:center;color:var(--muted);padding:26px 8px;font-size:13px}
.empty-ai b{display:block;color:var(--ink);font-size:15px;margin-bottom:4px}
.overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:22px;z-index:30}
.paywall{background:#fff;border-radius:20px;padding:26px 22px;max-width:340px;width:100%;text-align:center}
.paywall h2{margin:8px 0 6px;font-size:19px}
.paywall p{color:var(--muted);font-size:13px;margin:0 0 16px}
`;
  const body = `
<div class="mobile">
  <div class="hero">
    <div><div class="name" id="merchant">外卖 AI</div><div class="sub" id="packName">扫码即用 · 无需下载</div></div>
    <div class="remain" id="remain">— 次</div>
  </div>
  <div class="tabs"><button class="tab on" data-tab="chat">AI 对话</button><button class="tab" data-tab="image">AI 画图</button></div>
  <div class="panel" id="panelChat">
    <div class="chat" id="chat"><div class="empty-ai"><b>今天想聊点什么？</b>直接输入问题，或点下面的示例</div></div>
    <div class="chips" id="chips"></div>
    <div class="composer"><textarea id="input" rows="1" placeholder="输入你的问题…"></textarea><button class="send btn" id="send" aria-label="发送"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg></button></div>
  </div>
  <div class="panel hide" id="panelImage">
    <div class="imagebox">
      <div style="font-weight:650">描述你想要的画面</div>
      <div class="sizes" id="sizes"><button class="size on" data-size="1024x1024">方图</button><button class="size" data-size="1024x1536">竖图</button><button class="size" data-size="1536x1024">横图</button></div>
      <textarea id="prompt" rows="3" style="width:100%;border:1px solid var(--line);border-radius:12px;padding:10px;outline:none;resize:vertical" placeholder="例如：一杯冰美式，木桌，午后阳光，手机摄影"></textarea>
      <button class="btn" id="gen" style="width:100%;margin-top:10px">生成图片（计 1 次）</button>
      <div class="gallery" id="gallery"></div>
    </div>
  </div>
</div>
<div class="overlay hide" id="overlay"><div class="paywall"><div style="font-size:34px">⏳</div><h2 id="pwTitle">次数已用完</h2><p id="pwText">请联系商家再买一个次数包，扫码后立即恢复。</p><button class="btn" style="width:100%" onclick="location.reload()">我知道了</button></div></div>
`;
  const script = `
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const code=(location.pathname.split('/').pop()||'').toUpperCase();
const state={info:null,busy:false,history:[],size:'1024x1024'};
function setRemain(n){$('#remain').textContent=n+' 次'}
function exhausted(msg){$('#pwText').textContent=msg||'请联系商家再买一个次数包，扫码后立即恢复。';$('#overlay').classList.remove('hide')}
async function init(){
  const res=await fetch('/biz/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){$('#merchant').textContent='无法使用';$('#packName').textContent=(data.error&&data.error.message)||'核销码无效';exhausted((data.error&&data.error.message)||'这个码不能用了，请找商家确认。');return}
  state.info=data;setRemain(data.remaining);
  $('#merchant').textContent=data.merchantName;
  $('#packName').textContent=data.packName;
  if(data.remaining<=0)exhausted();
  const chips=['写一句开业祝福','推荐 3 款招牌饮品','把这段话改得更亲切：欢迎光临','解释一下这张桌贴怎么用'];
  $('#chips').innerHTML=chips.map(c=>'<button class="chip">'+esc(c)+'</button>').join('');
}
document.addEventListener('click',(ev)=>{
  const t=ev.target;if(!(t instanceof HTMLElement))return;
  if(t.dataset.tab){
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===t));
    $('#panelChat').classList.toggle('hide',t.dataset.tab!=='chat');
    $('#panelImage').classList.toggle('hide',t.dataset.tab!=='image');
  }
  if(t.dataset.size){state.size=t.dataset.size;document.querySelectorAll('.size').forEach(x=>x.classList.toggle('on',x===t))}
  if(t.classList.contains('chip')){$('#input').value=t.textContent;sendChat()}
});
function addMsg(role,text){const div=document.createElement('div');div.className='msg '+role;div.textContent=text;$('#chat').appendChild(div);$('#chat').scrollTop=$('#chat').scrollHeight;return div}
async function sendChat(){
  const text=$('#input').value.trim();if(!text||state.busy)return;
  if(state.info&&state.info.remaining<=0){exhausted();return}
  $('#input').value='';addMsg('user',text);state.history.push({role:'user',content:text});
  const bubble=document.createElement('div');bubble.className='msg ai';bubble.innerHTML='<span class="typing"><i></i><i></i><i></i></span>';$('#chat').appendChild(bubble);$('#chat').scrollTop=$('#chat').scrollHeight;
  state.busy=true;let full='';
  try{
    const res=await fetch('/biz/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:state.history,stream:true})});
    if(res.status===402||res.status===410){bubble.remove();exhausted('这个码的次数刚用完了，请联系商家续购。');state.info.remaining=0;setRemain(0);return}
    if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error((err.error&&err.error.message)||'请求失败')}
    const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
    for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\\n\\n');buf=parts.pop()||'';
      for(const part of parts){for(const line of part.split('\\n')){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;try{const j=JSON.parse(data);const d=j.choices&&j.choices[0]&&j.choices[0].delta&&j.choices[0].delta.content;if(d){full+=d;bubble.textContent=full;$('#chat').scrollTop=$('#chat').scrollHeight}}catch{}}}
    }
    if(!full)bubble.textContent='（这条没有返回内容，再试一次？）';
    else state.history.push({role:'assistant',content:full});
  }catch(e){bubble.classList.add('err');bubble.textContent='出错了：'+e.message}
  finally{state.busy=false;refresh()}
}
async function refresh(){try{const r=await fetch('/biz/api/me');if(r.ok){const d=await r.json();state.info=d;setRemain(d.remaining);if(d.remaining<=0)exhausted()}}catch{}}
$('#send').onclick=sendChat;
$('#input').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});
$('#gen').onclick=async()=>{
  const prompt=$('#prompt').value.trim();if(!prompt||state.busy)return;
  if(state.info&&state.info.remaining<=0){exhausted();return}
  state.busy=true;$('#gen').disabled=true;$('#gallery').innerHTML='<div class="ph">正在生成…</div>';
  try{
    const res=await fetch('/biz/api/image',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt,size:state.size,n:1})});
    if(res.status===402||res.status===410){exhausted('这个码的次数刚用完了，请联系商家续购。');$('#gallery').innerHTML='';return}
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error((data.error&&data.error.message)||'生成失败');
    const items=(data.data||[]).map(it=>it.b64_json?'data:image/png;base64,'+it.b64_json:it.url).filter(Boolean);
    $('#gallery').innerHTML=items.length?items.map(u=>'<figure><img src="'+esc(u)+'" alt="生成图"/></figure>').join(''):'<div class="ph">没有返回图片</div>';
  }catch(e){$('#gallery').innerHTML='<div class="ph">出错了：'+esc(e.message)+'</div>'}
  finally{state.busy=false;$('#gen').disabled=false;refresh()}
};
init();
`;
  return shell('外卖 AI · 扫码即用', css, body, script);
}

/* ================================================================== *
 * mock 收银台
 * ================================================================== */

export function payHtml(orderId: string, token: string, amountCny: number, subject: string): string {
  const css = `
body{display:flex;align-items:center;justify-content:center;min-height:100dvh}
.box{width:min(420px,92vw);padding:28px 24px;text-align:center}
.amt{font-size:34px;font-weight:750;letter-spacing:-.02em;margin:10px 0 2px}
.tag{display:inline-block;background:#fff7e6;color:#b45309;font-size:12px;padding:4px 10px;border-radius:999px;margin-bottom:14px}
`;
  const body = `<div class="card box"><div class="tag">演示收银台 · mock 支付</div><h2 style="margin:0;font-size:17px">${escapeHtml(subject)}</h2><div class="amt">¥${amountCny.toFixed(2)}</div><p class="muted" style="font-size:12px;margin:0 0 18px">订单 ${escapeHtml(orderId)}</p><button class="btn" id="pay" style="width:100%">我已完成支付</button><p class="muted" style="font-size:11px;margin-top:14px">此页仅用于本地演示；接入支付宝后由支付宝收银台接管。</p></div>`;
  const script = `
const $=(s)=>document.querySelector(s);
$('#pay').onclick=async()=>{
  $('#pay').disabled=true;$('#pay').textContent='处理中…';
  const res=await fetch('/biz/api/orders/${encodeURIComponent(orderId)}/mock-pay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:'${token.replace(/'/g, "\\'")}'})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){$('#pay').disabled=false;$('#pay').textContent='支付失败，重试';alert((data.error&&data.error.message)||'支付失败');return}
  $('#pay').textContent='支付成功，正在出码…';
  location.href='/biz?paid=${encodeURIComponent(orderId)}';
};
`;
  return shell('收银台 · 外卖 AI', css, body, script);
}

/* ================================================================== *
 * 可打印小票
 * ================================================================== */

export function printHtml(order: BizOrder, codes: BizCode[], pack: PackConfig | undefined): string {
  const cards = codes.map((c) => {
    const url = `/s/${c.code}`;
    return `<div class="ticket"><div class="q">${qrSvg(url)}</div><div class="c">${escapeHtml(c.code)}</div><div class="t">${escapeHtml(pack?.name ?? order.packName)}</div><div class="d">扫码即用 · 共 ${c.usesTotal} 次<br/>有效期至 ${new Date(c.expiresAt).toLocaleDateString('zh-CN')}</div><div class="m">${escapeHtml(order.merchantName)}</div></div>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>打印小票 · ${escapeHtml(order.id)}</title><style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#0f172a}
.sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm;padding:12mm}
.ticket{border:1px dashed #94a3b8;border-radius:4mm;padding:6mm;display:flex;flex-direction:column;align-items:center;break-inside:avoid}
.ticket .q svg{width:44mm;height:44mm}
.ticket .c{font-family:ui-monospace,Menlo,monospace;font-size:16pt;font-weight:700;letter-spacing:.04em;margin-top:2mm}
.ticket .t{font-size:10pt;color:#334155;margin-top:1mm}
.ticket .d{font-size:8pt;color:#64748b;text-align:center;margin-top:1mm;line-height:1.4}
.ticket .m{font-size:8pt;color:#94a3b8;margin-top:2mm}
@media print{@page{size:A4;margin:0}.sheet{padding:8mm}}
</style></head><body><div class="sheet">${cards}</div><script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`;
}

/* ================================================================== *
 * 外卖单码标签（58mm × 40mm 热敏纸）
 * ================================================================== */

export interface LabelInput {
  code: string;
  scanUrl: string;
  externalNo?: string;
  packName: string;
  merchantName: string;
  usesTotal: number;
  expiresAt: number;
}

export function labelHtml(input: LabelInput): string {
  const order = input.externalNo ? `单号 ${escapeHtml(input.externalNo)}` : '未绑定订单';
  const expires = escapeHtml(new Date(input.expiresAt).toLocaleDateString('zh-CN'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>标签 · ${escapeHtml(input.code)}</title><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:58mm;height:40mm}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;display:flex;align-items:center;gap:2.5mm;padding:2mm 2.5mm}
.q{width:26mm;height:26mm;flex:none}
.q svg{width:100%;height:100%}
.t{min-width:0;flex:1;line-height:1.25}
.m{font-size:8pt;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.b{font-size:7.5pt;color:#334155;margin-top:.6mm}
.o{font-family:ui-monospace,Menlo,monospace;font-size:6.5pt;margin-top:.8mm;word-break:break-all}
.d{font-size:6pt;color:#64748b;margin-top:.6mm}
@page{size:58mm 40mm;margin:0}
@media print{body{width:58mm;height:40mm}}
</style></head><body><div class="q">${qrSvg(input.scanUrl)}</div><div class="t"><div class="m">${escapeHtml(input.merchantName)}</div><div class="b">扫码即用 · ${input.usesTotal} 次</div><div class="o">${order}</div><div class="d">至 ${expires}</div></div><script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fb;display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0}.b{background:#fff;border:1px solid #e6ebf4;border-radius:16px;padding:28px;max-width:360px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#64748b;font-size:13px;margin:0}</style></head><body><div class="b"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

export function summaryCards(summary: BizSummary): string {
  return `营收 ¥${summary.revenueCny.toFixed(2)} · 已付 ${summary.paidOrderCount} 单 · 核销 ${summary.usesUsed}/${summary.usesSold} 次`;
}
