import { describe, expect, it } from "vitest";
import { aggregateChartGranularity, chartDomain, chartToCsv, filterChartPeriod, formatChartValue, type ChartModel } from "./chart";

const model: ChartModel = { title:"Kasa",description:"",annotations:[],unknownCount:1,sourceLabel:"test",asOf:"2026-07-13",series:[{id:"cash",label:"Kasa",tone:"info",format:"currency",points:Array.from({length:14},(_,i)=>({key:String(i),label:String(i),value:i===2?null:i-5}))}] };

describe("analytics chart rules",()=>{
  it("keeps null values out of the numeric domain",()=>expect(chartDomain(model)).toEqual({min:-5,max:8}));
  it("filters without mutating the source model",()=>{expect(filterChartPeriod(model,"3m").series[0].points).toHaveLength(3);expect(model.series[0].points).toHaveLength(14)});
  it("exports unknown values as an empty CSV cell",()=>expect(chartToCsv(model)).toContain('"2","2",""'));
  it("discloses null instead of formatting it as zero",()=>expect(formatChartValue(null,"currency")).toBe("TUTAR EKSİK"));
  it("anchors forward periods to asOf instead of taking the last points",()=>{
    const forward={...model,asOf:"2026-07-13",timeDirection:"forward" as const,series:[{...model.series[0],points:[{key:"2026-07",label:"Tem",value:1},{key:"2026-10",label:"Eki",value:2},{key:"2027-10",label:"Son",value:3}]}]};
    expect(filterChartPeriod(forward,"6m").series[0].points.map(p=>p.key)).toEqual(["2026-07","2026-10"]);
  });
  it("keeps overdue payment context in every forward horizon",()=>{
    const forward={...model,asOf:"2026-07-13",timeDirection:"forward" as const,minimumVisibleSeries:["overdue"],series:[{...model.series[0],id:"overdue",points:[{key:"2026-06-01",label:"Gecikmiş",value:5},{key:"2026-07-20",label:"Plan",value:2},{key:"2027-10-01",label:"Uzak",value:3}]}]};
    expect(filterChartPeriod(forward,"3m").series[0].points.map(p=>p.key)).toEqual(["2026-06-01","2026-07-20"]);
  });
  it("preserves known totals and unknowns while changing granularity",()=>{
    const daily:ChartModel={...model,timeDirection:"forward",series:[{...model.series[0],points:[{key:"2026-07-13",label:"13",value:10,meta:{unknownAmountCount:0}},{key:"2026-07-14",label:"14",value:20,meta:{unknownAmountCount:1}}]}]};
    const weekly=aggregateChartGranularity(daily,"week");
    expect(weekly.series[0].points[0].value).toBe(30);
    expect(weekly.series[0].points[0].meta?.unknownAmountCount).toBe(1);
  });
  it("keeps 12 and 24 month forward horizons distinct",()=>{
    const points=Array.from({length:25},(_,index)=>{const month=String((6+index)%12+1).padStart(2,"0");const year=2026+Math.floor((6+index)/12);return {key:`${year}-${month}-13`,label:String(index),value:1}});
    const forward={...model,asOf:"2026-07-13",timeDirection:"forward" as const,series:[{...model.series[0],points}]};
    expect(filterChartPeriod(forward,"12m").series[0].points).toHaveLength(12);
    expect(filterChartPeriod(forward,"24m").series[0].points).toHaveLength(24);
  });
  it("anchors historical month windows to asOf instead of data tail",()=>{
    const monthly={...model,asOf:"2026-07-13",series:[{...model.series[0],points:[
      {key:"2026-01",label:"2026-01",value:1},
      {key:"2026-02",label:"2026-02",value:2},
      {key:"2026-03",label:"2026-03",value:3},
      {key:"2026-04",label:"2026-04",value:4},
      {key:"2026-05",label:"2026-05",value:5},
      {key:"2026-06",label:"2026-06",value:6},
      {key:"2026-07",label:"2026-07",value:7},
      {key:"2026-08",label:"2026-08",value:8},
      {key:"2026-09",label:"2026-09",value:9},
    ]}]};
    expect(filterChartPeriod(monthly,"3m").series[0].points.map((p)=>p.key)).toEqual(["2026-05","2026-06","2026-07"]);
  });
  it("uses month-aligned windows for forward monthly granularity",()=>{
    const points=Array.from({length:14},(_,index)=>{const month=String((7+index-1)%12+1).padStart(2,"0");const year=2026+Math.floor((7+index-1)/12);return {key:`${year}-${month}-01`,label:`${year}-${month}`,value:1}});
    const forward={...model,asOf:"2026-07-13",timeDirection:"forward" as const,series:[{...model.series[0],points}]};
    const out=filterChartPeriod(forward,"12m","month").series[0].points;
    expect(new Set(out.map((p)=>p.key.slice(0,7))).size).toBe(12);
    expect(out[0].key.slice(0,7)).toBe("2026-07");
  });
  it("does not apply month slicing to categorical charts",()=>{
    const categorical={...model,timeDirection:"categorical" as const,series:[{...model.series[0],points:[
      {key:"torna",label:"Torna",value:10},
      {key:"freze",label:"Freze",value:20},
      {key:"lazer",label:"Lazer",value:30},
      {key:"cnc",label:"CNC",value:40},
    ]}]};
    expect(filterChartPeriod(categorical,"3m").series[0].points).toHaveLength(4);
  });
});
