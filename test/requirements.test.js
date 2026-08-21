const test=require('node:test');
const assert=require('node:assert/strict');
const { chunkSrt, parseAndValidateSrt, buildMetadataContext, manifest }=require('../index');

test('chunks SRT into bounded contiguous blocks',()=>{
  const s=Array.from({length:95},(_,i)=>`${i+1}\n00:00:${String(i%60).padStart(2,'0')},000 --> 00:00:${String((i+1)%60).padStart(2,'0')},000\nLine ${i+1}`).join('\n\n');
  const chunks=chunkSrt(s,45);
  assert.deepEqual(chunks.map(c=>c.entries.length),[45,45,5]);
  assert.equal(chunks[1].entries[0].id,'46');
});

test('metadata context includes title plot and TMDB character genders',()=>{
  const context=buildMetadataContext({title:'Demo',overview:'A story',credits:[{name:'Ana',gender:1},{name:'John',gender:2},{name:'Mystery',gender:0}]});
  assert.match(context,/Demo/); assert.match(context,/A story/); assert.match(context,/Ana: Female/); assert.match(context,/John: Male/); assert.match(context,/Mystery: Unknown/);
});

test('SRT validator rejects count and timestamp changes',()=>{
 const source='1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nReady?';
 assert.equal(parseAndValidateSrt(source,'1\n00:00:00,000 --> 00:00:01,000\nŽivjo\n\n2\n00:00:02,000 --> 00:00:03,000\nPripravljena?').length,2);
 assert.throws(()=>parseAndValidateSrt(source,'1\n00:00:09,000 --> 00:00:01,000\nŽivjo'));
});

test('manifest advertises Slovenian subtitle resource',()=>{const m=manifest(); assert.deepEqual(m.resources,['subtitles']); assert.equal(m.idPrefixes[0],'tt');});
module.exports={};
