/*
 * Compact browser-side Random Forest for local mineral-prospectivity experiments.
 * Labels are documented gold occurrences versus pseudo-absence/background pixels.
 * Output is a relative similarity score, never a calibrated gold probability.
 */
(() => {
  'use strict';
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  let seed = 91723;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  function shuffle(arr) { const a = arr.slice(); for (let i=a.length-1;i>0;i--) { const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  function gini(positives, count) { if (!count) return 0; const p=positives/count; return 2*p*(1-p); }
  function leaf(rows) { return { p: rows.reduce((s,r)=>s+r.label,0) / Math.max(1, rows.length) }; }
  function chooseFeatures(n, m) { return shuffle(Array.from({length:n},(_,i)=>i)).slice(0,m); }
  function buildTree(rows, depth, featureCount) {
    const positives=rows.reduce((s,r)=>s+r.label,0);
    if (depth>=7 || rows.length<8 || positives===0 || positives===rows.length) return leaf(rows);
    const base=gini(positives,rows.length); if (base<1e-8) return leaf(rows);
    const mtry=Math.max(2,Math.ceil(Math.sqrt(featureCount)));
    const candidates=chooseFeatures(featureCount,Math.min(mtry,featureCount));
    let best=null, bestGain=0;
    for (const f of candidates) {
      const ordered=rows.map(r=>r.x[f]).filter(Number.isFinite).sort((a,b)=>a-b);
      if (ordered.length<8) continue;
      const thresholds=[];
      for (let q=1;q<10;q++) {
        const i=Math.floor((ordered.length-1)*q/10);
        const t=(ordered[i]+ordered[Math.min(ordered.length-1,i+1)])/2;
        if (Number.isFinite(t) && !thresholds.some(v=>Math.abs(v-t)<1e-12)) thresholds.push(t);
      }
      for (const threshold of thresholds) {
        let lp=0,ln=0,rp=0,rn=0;
        for (const row of rows) {
          if (row.x[f] <= threshold) { if (row.label) lp++; else ln++; }
          else { if (row.label) rp++; else rn++; }
        }
        const nl=lp+ln,nr=rp+rn;
        if (nl<3 || nr<3) continue;
        const gain=base-(nl/rows.length)*gini(lp,nl)-(nr/rows.length)*gini(rp,nr);
        if (gain>bestGain) { bestGain=gain; best={f,t:threshold}; }
      }
    }
    if (!best || bestGain<0.002) return leaf(rows);
    const left=[],right=[];
    for (const row of rows) (row.x[best.f] <= best.t ? left : right).push(row);
    if (!left.length || !right.length) return leaf(rows);
    return { f:best.f,t:best.t,l:buildTree(left,depth+1,featureCount),r:buildTree(right,depth+1,featureCount) };
  }
  function predictTree(tree, x) { let node=tree, guard=0; while (node && node.p===undefined && guard++<20) node=x[node.f]<=node.t?node.l:node.r; return clamp(Number(node?.p)||0,0,1); }
  function fitForest(rows, featureCount, treeCount=32) {
    const trees=[];
    for(let t=0;t<treeCount;t++) {
      const boot=[]; for(let i=0;i<rows.length;i++) boot.push(rows[Math.floor(rnd()*rows.length)]);
      trees.push(buildTree(boot,0,featureCount));
    }
    return trees;
  }
  function predictForest(trees,x) { let total=0; for(const tree of trees) total+=predictTree(tree,x); return total/Math.max(1,trees.length); }
  function aucScore(scored) {
    const pos=scored.filter(r=>r.label===1).map(r=>r.score), neg=scored.filter(r=>r.label===0).map(r=>r.score);
    if(!pos.length||!neg.length) return null;
    let wins=0; for(const p of pos) for(const n of neg) wins += p>n ? 1 : p===n ? .5 : 0;
    return wins/(pos.length*neg.length);
  }
  function uniqueGroups(rows, label) { return [...new Set(rows.filter(r=>r.label===label).map(r=>r.group))]; }
  function sendError(message) { self.postMessage({type:'error',message}); }
  self.onmessage = (event) => {
    const msg=event.data||{}; if(msg.type!=='train-predict') return;
    try {
      seed=Number(msg.seed)||91723;
      const samples=(msg.samples||[]).filter(r=>Array.isArray(r.x)&&r.x.every(Number.isFinite)&&(r.label===0||r.label===1));
      const pixels=msg.pixelFeatures, valid=msg.validMask, featureCount=Number(msg.featureCount)||0;
      if(!featureCount||!pixels||!valid) throw new Error('لم تصل مصفوفة خصائص صالحة إلى عامل النموذج.');
      const positives=samples.filter(r=>r.label===1), negatives=samples.filter(r=>r.label===0);
      const uniquePositiveGroups=uniqueGroups(samples,1);
      if(uniquePositiveGroups.length<5) throw new Error('يلزم 5 مواقع ذهب موثقة مستقلة على الأقل لتكوين نموذج تجريبي. والأفضل 10 مواقع أو أكثر.');
      if(negatives.length<25) throw new Error('عينات الخلفية قليلة؛ تعذر إنشاء مجموعة مقارنة مناسبة.');
      if(samples.some(r=>r.x.length!==featureCount)) throw new Error('عدد خصائص بعض عينات التدريب لا يتطابق.');
      self.postMessage({type:'progress',pct:5,text:'تقسيم مواقع التدريب والتحقق…'});
      const positiveGroups=shuffle(uniquePositiveGroups);
      const testPositiveGroups=new Set(positiveGroups.slice(0,Math.max(1,Math.floor(positiveGroups.length*.25))));
      const bgGroups=shuffle(uniqueGroups(samples,0));
      let testBgGroups=new Set(bgGroups.slice(0,Math.max(1,Math.floor(bgGroups.length*.20))));
      let train=samples.filter(r=> !(r.label===1 && testPositiveGroups.has(r.group)) && !(r.label===0 && testBgGroups.has(r.group)));
      let test=samples.filter(r=> (r.label===1 && testPositiveGroups.has(r.group)) || (r.label===0 && testBgGroups.has(r.group)));
      if(test.filter(r=>r.label===0).length<10) {
        const neg=shuffle(negatives), nTest=Math.max(10,Math.floor(neg.length*.2));
        const testNeg=new Set(neg.slice(0,nTest));
        train=samples.filter(r=>r.label===1 ? !testPositiveGroups.has(r.group) : !testNeg.has(r));
        test=samples.filter(r=>r.label===1 ? testPositiveGroups.has(r.group) : testNeg.has(r));
      }
      const trainPos=train.filter(r=>r.label===1).length, trainNeg=train.filter(r=>r.label===0).length;
      const testPos=test.filter(r=>r.label===1).length, testNeg=test.filter(r=>r.label===0).length;
      if(trainPos<4 || trainNeg<20 || testPos<1 || testNeg<5) throw new Error('تعذر بناء تقسيم تحقق صالح. أضف مواقع موثقة أكثر أو وسّع المنطقة بحيث تحتوي على عينات خلفية متنوعة.');
      self.postMessage({type:'progress',pct:14,text:`تدريب 32 شجرة على ${trainPos} موقعًا موجبًا و${trainNeg} عينة خلفية…`});
      const validationTrees=fitForest(train,featureCount,32);
      const scoredTest=test.map(r=>({label:r.label,score:predictForest(validationTrees,r.x),group:r.group}));
      const auc=aucScore(scoredTest);
      let tp=0,tn=0,fp=0,fn=0;
      for(const r of scoredTest) { const pred=r.score>=.5?1:0; if(r.label===1&&pred===1)tp++; else if(r.label===0&&pred===0)tn++; else if(r.label===0)fp++; else fn++; }
      const sensitivity=tp+fn?tp/(tp+fn):null, specificity=tn+fp?tn/(tn+fp):null;
      const metrics={
        auc:auc===null?null:Number(auc.toFixed(4)),
        balancedAccuracy:sensitivity===null||specificity===null?null:Number(((sensitivity+specificity)/2).toFixed(4)),
        sensitivity:sensitivity===null?null:Number(sensitivity.toFixed(4)),
        specificity:specificity===null?null:Number(specificity.toFixed(4)),
        trainPositive:trainPos,trainBackground:trainNeg,testPositive:testPos,testBackground:testNeg,
        positiveSites:uniquePositiveGroups.length, totalSamples:samples.length,
        validationType:'held-out known-site groups + background pseudo-absence',
        warning:'المقاييس تجريبية وتعتمد على نقاط USGS المنتقاة وخلفية شبه غائبة؛ ليست تحققًا ميدانيًا أو ضمانًا للأداء خارج المنطقة.'
      };
      self.postMessage({type:'progress',pct:42,text:'اكتمل الاختبار الأولي؛ إعادة تدريب النموذج على جميع العينات…'});
      const finalTrees=fitForest(samples,featureCount,40);
      const model={algorithm:'GOLD SPECTRA compact Random Forest',version:1,featureNames:msg.featureNames||[],trees:finalTrees,training:{...metrics,trainedAt:new Date().toISOString(),sceneId:String(msg.sceneId||''),positiveLabel:'documented gold occurrence',negativeLabel:'pseudo-absence/background; not confirmed absence'}};
      const total=valid.length, scores=new Float32Array(total); scores.fill(-1);
      const chunk=6000;
      for(let start=0;start<total;start+=chunk) {
        const end=Math.min(total,start+chunk);
        for(let i=start;i<end;i++) if(valid[i]) {
          const x=new Array(featureCount),offset=i*featureCount;
          let okay=true; for(let f=0;f<featureCount;f++){x[f]=pixels[offset+f];if(!Number.isFinite(x[f])){okay=false;break;}}
          if(okay)scores[i]=predictForest(finalTrees,x);
        }
        self.postMessage({type:'progress',pct:45+Math.round(end/total*50),text:`رسم خريطة النموذج ${Math.round(end/total*100)}%…`});
      }
      self.postMessage({type:'complete',scores,metrics,model,featureCount,totalPixels:total},[scores.buffer]);
    } catch(error) { sendError(error?.message||'تعذر تدريب النموذج.'); }
  };
})();
