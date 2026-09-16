import { t } from '../../../i18n';
import { useEffect, useState } from 'react';
import { Dialog, Table, Td, Th } from '../../../components';
import { formatTime, formatPercent } from '../../../lib';
import type { UsageRow } from '../../../types/contract';
import styles from './UsageTable.module.css';

export interface UsageTableProps { rows:readonly UsageRow[]; names?:Record<string,string>; onInspectDegrade:(row:UsageRow)=>void }
const PAGE_SIZE=20;
const count=(n:number|null)=>n===null?'—':n.toLocaleString('en-US');
function ratio(r:UsageRow){if(r.in===null||r.cr===null||r.cw===null)return null;const input=r.in+r.cr+r.cw;return input>0?r.cr/input:null;}
function shortTime(ts:number){const d=new Date(ts*1000);return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`;}
function harness(row:UsageRow){return row.harness==='codex'?'Codex':row.harness==='claude'?'Claude Code':t("未记录");}
export function UsageTable({rows,names={},onInspectDegrade}:UsageTableProps){
 const [page,setPage]=useState(0),[selected,setSelected]=useState<UsageRow|null>(null);
 const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE)),current=Math.min(page,pages-1),start=current*PAGE_SIZE;
 useEffect(()=>setPage(0),[rows.length]);
 const provider=(r:UsageRow)=>names[`${r.providerApp??'claude'}:${r.providerId}`]??(r.providerId&&r.providerId!=='unknown'?r.providerId:t("未记录"));
 return <>
  <div className={styles.pagination}><span>{t("点击一行查看完整详情")}</span><span>{rows.length?start+1:0}–{Math.min(start+PAGE_SIZE,rows.length)} / {rows.length.toLocaleString()}</span><button disabled={current===0} onClick={()=>setPage(current-1)}>{t("上一页")}</button><button disabled={current===pages-1} onClick={()=>setPage(current+1)}>{t("下一页")}</button></div>
  <Table stickyHeader framed={false} minWidth={920} layout="fixed" className={styles.usageTable} wrapperClassName={styles.tableViewport} aria-label={t("调用用量明细")}>
   <colgroup><col style={{width:100}}/><col style={{width:90}}/><col style={{width:168}}/><col style={{width:112}}/><col style={{width:78}}/><col style={{width:78}}/><col style={{width:90}}/><col style={{width:68}}/><col style={{width:78}}/></colgroup>
   <thead><tr><Th>{t("时间（最新在前）")}</Th><Th>Harness</Th><Th>{t("模型")}</Th><Th>Provider</Th><Th numeric>{t("输入")}</Th><Th numeric>{t("缓存写入")}</Th><Th numeric>{t("缓存读取")}</Th><Th numeric>{t("缓存率")}</Th><Th numeric>{t("输出")}</Th></tr></thead>
   <tbody>{rows.slice(start,start+PAGE_SIZE).map((r,i)=><tr key={`${r.ts}-${r.model}-${i}`} tabIndex={0} onClick={()=>setSelected(r)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(r);}}} aria-label={t("{0} {1} {2} 用量详情", [formatTime(r.ts), harness(r), r.model])}>
    <Td mono title={formatTime(r.ts)}>{shortTime(r.ts)}</Td>
    <Td><span className={styles.harness}><i style={{background:r.harness==='codex'?'#3986e6':r.harness==='claude'?'#d88043':'#8b8b96'}}/>{harness(r)}</span></Td>
    <Td mono className={styles.name}>{r.model||t("未记录")}</Td><Td className={styles.name}>{provider(r)}</Td>
    <Td numeric>{count(r.in)}</Td><Td numeric>{count(r.cw)}</Td><Td numeric>{count(r.cr)}</Td><Td numeric>{formatPercent(ratio(r))}</Td><Td numeric>{count(r.out)}</Td>
   </tr>)}</tbody>
  </Table>
  <Dialog open={selected!==null} onClose={()=>setSelected(null)} title={t("用量详情")} description={t("按实际报告字段显示；缺失字段为 —，不回填估算数。")}>
   {selected&&<><dl className={styles.details}>{[
    [t("时间"),formatTime(selected.ts)],['Harness',harness(selected)],[t("归属依据"),selected.harnessEvidence==='legacy-claude-hub'?t("历史 Claude Code 网关流水"):t("明确记录")],['Provider',provider(selected)],['Provider ID',selected.providerId??t("未记录")],[t("渠道"),selected.channel||t("未记录")],[t("模型"),selected.model||t("未记录")],[t("协议"),selected.format],[t("用量来源"),selected.source==='codex-session'?t("Codex 本地会话"):selected.source||t("未记录")],[t("普通输入"),count(selected.in)],[t("缓存写入"),count(selected.cw)],[t("缓存读取"),count(selected.cr)],[t("缓存读取占输入比例"),formatPercent(ratio(selected))],[t("输出"),count(selected.out)],[t("降级信息"),selected.deg.join('、')||t("无")],
   ].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{selected.deg.length>0&&<button className={styles.degrade} onClick={()=>{onInspectDegrade(selected);setSelected(null);}}>{t("查看降级诊断")}</button>}</>}
  </Dialog>
 </>;
}
