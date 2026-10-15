import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('local modules stay acyclic and respect shared, hosted and website boundaries',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),graph=new Map();
  for(const folder of ['collector','calendar','slackbot','website','shared','diagnostics','supabase/functions']){
    for(const name of await readdir(resolve(root,folder),{recursive:true})){
      if(!/\.(?:js|ts)$/.test(name))continue;
      const path=resolve(root,folder,name),code=await readFile(path,'utf8');
      const imports=[...code.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)]
        .map(match=>match[1]).filter(spec=>spec.startsWith('.')&&/\.(?:js|ts)$/.test(spec))
        .map(spec=>relative(root,resolve(dirname(path),spec)));
      graph.set(relative(root,path),imports);
    }
  }
  const checked=new Set();
  const visit=(path,ancestors=[])=>{
    assert.ok(!ancestors.includes(path),'Local import cycle: '+[...ancestors,path].join(' -> '));
    if(checked.has(path))return;
    assert.ok(graph.has(path),'Missing local module: '+path);
    for(const dependency of graph.get(path)){
      if(path.startsWith('shared/'))assert.ok(dependency.startsWith('shared/'),'Shared rule imports feature: '+path+' -> '+dependency);
      visit(dependency,[...ancestors,path]);
    }
    checked.add(path);
  };
  for(const path of graph.keys())visit(path);
  const reachable=(path,seen=new Set())=>{
    if(seen.has(path))return seen;
    seen.add(path);
    for(const dependency of graph.get(path))reachable(dependency,seen);
    return seen;
  };
  for(const entry of ['supabase/functions/scout-collect-hsa/index.ts','website/main.js']){
    for(const path of reachable(entry)){
      assert.ok(!(await readFile(resolve(root,path),'utf8')).includes('captureTraffic'),entry+' includes traffic capture: '+path);
      assert.ok(!path.startsWith('diagnostics/'),entry+' imports local diagnostics: '+path);
      assert.ok(!path.startsWith('collector/discovery/'),entry+' imports publisher discovery: '+path);
    }
  }
});
