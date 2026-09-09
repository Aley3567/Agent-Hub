import { useMemo, useState } from 'react';
import { formatTokens, formatCostUsd, formatTime } from '../../../lib';
import type { UsageSummary } from '../../../types/contract';
import styles from './UsageChart.module.css';
type Group='harness'|'provider'|'components';
const FIELDS=['in','out','cr','cw'] as const;
const LABELS:Record<string,string>={claude:'Claude Code',codex:'Codex',unknown:'未记录',in:'普通输入',out:'输出',cr:'缓存读取',cw:'缓存写入'};
const COLORS:Record<string,string>={claude:'#d88043',codex:'#3986e6',unknown:'#8b8b96',in:'#5982c9',out:'#9b77d4',cr:'#12a59a',cw:'#d69b35'};
const PALETTE=['#488dd0','#b17ace','#d08948','#28a38e','#d06588','#8e9f42','#7179d1','#ba845a'];
function color(key:string){let hash=0;for(const c of key)hash=(hash*31+c.charCodeAt(0))>>>0;return COLORS[key]??PALETTE[hash%PALETTE.length];}
export function UsageChart({usage,names={}}:{usage:UsageSummary;names?:Record<string,string>}){
 const [group,setGroup]=useState<Group>('harness'),[metric,setMetric]=useState<'tokens'|'cost'>('tokens');
 const [hidden,setHidden]=useState<Set<string>>(new Set()),[selected,setSelected]=useState<number|null>(null);
 const points=useMemo(()=>usage.series.map(p=>({t:p.t,turns:p.turns,slices:group==='components'?FIELDS.map((key,i)=>({key,value:metric==='tokens'?(p[key]??0):p.components_cost?.[i]??null})):(group==='harness'?p.harnesses??[]:p.providers??[]).map(s=>({key:s.key,value:metric==='tokens'?s.tokens:s.cost}))})),[usage,group,metric]);
 const keys=Array.from(new Set(points.flatMap(p=>p.slices.map(s=>s.key)))).sort();
 const max=Math.max(0,...points.map(p=>p.slices.filter(s=>!hidden.has(s.key)).reduce((n,s)=>n+(s.value??0),0)))||1;
 const fmt=(n:number)=>metric==='tokens'?formatTokens(n):formatCostUsd(n);
 const label=(k:string)=>group==='provider'?names[k]??LABELS[k]??k:LABELS[k]??k;
 const w=Math.max(800,points.length*18),left=64,bottom=208,top=12,step=(w-left-12)/Math.max(points.length,1),bar=Math.max(2,step*.66);
 const detail=selected===null?null:points[selected];
 return <section className={styles.chart} aria-label="用量趋势">
  <div className={styles.heading}><div><strong>用量趋势</strong><p>点击图例筛选，点击柱子查看时段明细</p></div><div className={styles.controls}>
   <div role="group" aria-label="图表指标">{([['tokens','Token 用量'],['cost','估算费用']] as const).map(([v,l])=><button key={v} aria-pressed={metric===v} onClick={()=>setMetric(v)}>{l}</button>)}</div>
   <div role="group" aria-label="堆叠维度">{([['harness','按 Harness'],['provider','按 Provider'],['components','按构成']] as const).map(([v,l])=><button key={v} aria-pressed={group===v} onClick={()=>{setGroup(v);setHidden(new Set());setSelected(null);}}>{l}</button>)}</div>
  </div></div>
  <div className={styles.scroll}><svg viewBox={`0 0 ${w} 238`} style={{minWidth:w>1000?w:undefined}} role="img" aria-label={`${metric==='tokens'?'Token':'估算费用'}堆叠柱状图`}>
   {[0,.25,.5,.75,1].map(f=><g key={f}><line x1={left} x2={w-12} y1={bottom-f*(bottom-top)} y2={bottom-f*(bottom-top)} className={styles.grid}/><text x={left-8} y={bottom-f*(bottom-top)+4} textAnchor="end" className={styles.axis}>{fmt(max*f)}</text></g>)}
   {points.map((p,i)=>{let y=bottom;const active=p.slices.filter(s=>!hidden.has(s.key)),unknown=metric==='cost'&&active.some(s=>s.value===null);const description=`${formatTime(p.t)} · ${p.turns} 条用量记录\n`+active.map(s=>`${label(s.key)}：${s.value===null?'未知':fmt(s.value)}`).join('\n');return <g key={p.t} tabIndex={0} role="button" aria-label={description} onMouseEnter={()=>setSelected(i)} onFocus={()=>setSelected(i)} onClick={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')setSelected(i);}} className={styles.bar}>
    <title>{description}</title><rect x={left+i*step} y={top} width={step} height={bottom-top} fill="transparent"/>
    {active.map(s=>{const height=(s.value??0)/max*(bottom-top);y-=height;return <rect key={s.key} x={left+i*step+(step-bar)/2} y={y} width={bar} height={height} fill={color(s.key)} opacity={unknown?.45:1}/>;})}
    {unknown&&<text x={left+(i+.5)*step} y={bottom-4} textAnchor="middle" className={styles.axis}>?</text>}
    {(i%Math.max(1,Math.ceil(points.length/9))===0||i===points.length-1)&&<text x={left+(i+.5)*step} y={228} textAnchor="middle" className={styles.axis}>{new Date(p.t*1000).toLocaleString('zh-CN',usage.granularity==='hour'?{month:'numeric',day:'numeric',hour:'2-digit'}:{month:'numeric',day:'numeric'})}</text>}
   </g>;})}
  </svg></div>
  <div className={styles.legend}>{keys.map(k=><button key={k} aria-pressed={!hidden.has(k)} onClick={()=>setHidden(old=>{const next=new Set(old);next.has(k)?next.delete(k):next.add(k);return next;})}><span style={{background:color(k)}}/>{label(k)}</button>)}</div>
  <div className={styles.detail} aria-live="polite">{detail?<><strong>{formatTime(detail.t)}</strong><span>{detail.turns} 条用量记录</span>{detail.slices.filter(s=>!hidden.has(s.key)).map(s=><span key={s.key}>{label(s.key)} <b>{s.value===null?'未知':fmt(s.value)}</b></span>)}</>:<span>选择时段查看明细</span>}</div>
  {metric==='cost'&&<p className={styles.note}>“?” 表示该时段有未定价模型或缺失用量字段；已知部分不代表完整费用。</p>}
  {!!usage.incompleteTurns&&<p className={styles.note}>{usage.incompleteTurns} 条记录缺少部分 Token 字段；仅累计已报告用量；缓存率使用输入字段完整的记录，完整费用仍为未知。</p>}
 </section>;
}
