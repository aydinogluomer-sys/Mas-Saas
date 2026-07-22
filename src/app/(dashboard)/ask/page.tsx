import { redirect } from "next/navigation";
export default async function LegacyAskPage({searchParams}:{searchParams:Promise<{response?:string}>}){const {response}=await searchParams;redirect(response?`/insights/ask/${response}`:"/insights/ask")}
