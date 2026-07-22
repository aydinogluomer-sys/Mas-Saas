import Link from "next/link";
import { askQuestionAction } from "@/app/(dashboard)/ask/actions";
import { getPool } from "@/lib/db";
import { listAiResponses } from "@/lib/ai/engine";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
export const dynamic="force-dynamic";
const samples=["Bugün ne ödenecek?","7 günde ne kadar çıkış var?","Kasa ne zaman negatife düşüyor?","En büyük yoğunlaşma nerede?","Hangi aksiyon öncelikli?"];
export default async function AskPage(){const recent=await listAiResponses(getPool(),20);return <><PageHeader title="Finansal Soru-Cevap" subtitle="Hesaplamayı deterministik motor yapar; AI yalnız kanıtlanmış sonuçları açıklar." meta={<><Badge tone="green">kaynak kanıtlı</Badge><Badge tone="amber">mali mutasyon yok</Badge></>}/><Panel title="Karar sorusu"><form action={askQuestionAction} className="space-y-3"><textarea name="question" required rows={5} className="field-control w-full resize-y p-3" placeholder="Önümüzdeki 30 günde çek ve kredi yükü ne kadar?"/><div className="flex flex-wrap gap-2"><button className="button-accent px-3 py-2">Cevapla</button><label className="button-ghost px-3 py-2"><input name="forceDeterministic" type="checkbox"/> Yalnız deterministik cevap</label></div></form><div className="mt-3 flex flex-wrap gap-2">{samples.map(q=><form key={q} action={askQuestionAction}><input type="hidden" name="question" value={q}/><button className="button-ghost px-2 py-1.5">{q}</button></form>)}</div></Panel><Panel title={`Geçmiş cevaplar · ${recent.length}`}>{recent.map(r=><Link key={r.id} href={`/insights/ask/${r.id}`} className="grid gap-2 border-b border-line-faint py-2 text-sm sm:grid-cols-[1fr_auto_auto]"><span>{r.question}</span><Badge tone={r.response_mode==="openai"?"green":r.response_mode==="fallback"?"amber":"neutral"}>{r.response_mode}</Badge><span className="text-tone-3">{r.created_at} →</span></Link>)}</Panel></>}
