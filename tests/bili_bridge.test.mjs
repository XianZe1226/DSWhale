import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedRequest, validateCommand, redact, isolatedEnvironment } from '../dswhale/bili_bridge/policy.mjs';

test('loopback API needs both a token and same-origin browser context', () => {
  const good = {headers:{host:'127.0.0.1:8421',authorization:'Bearer local-test-token',origin:'http://127.0.0.1:8421','sec-fetch-site':'same-origin'}};
  assert.equal(trustedRequest(good, 8421, 'local-test-token'), true);
  for (const headers of [{authorization:''},{host:'attacker.test:8421'},{origin:'https://attacker.test'},{'sec-fetch-site':'cross-site'}])
    assert.equal(trustedRequest({headers:{...good.headers,...headers}},8421,'local-test-token'),false);
});
test('agent cannot execute shells, reset quotas, or choose arbitrary files', () => {
  assert.deepEqual(validateCommand(['feed','--n','3']), ['feed','--n','3']);
  for(const args of [['../../bin/sh'],['quota','allow','any'],['traffic','reset'],['dynamic-image','--path','/private/photo.jpg'],['notify','hello'],['dm','--msg','x','--go']])
    assert.throws(()=>validateCommand(args));
  assert.deepEqual(validateCommand(['dm','--msg','x','--go'],{manual:true}),['dm','--msg','x','--go']);
});
test('secrets and installation paths do not enter model tool output', () => {
  assert.equal(redact('at /private/local-root/path SESSDATA=fixture-secret',{root:'/private/local-root',secrets:['fixture-secret']}),'at {STATE}/path SESSDATA=[redacted]');
});
test('upstream data is isolated without changing system HOME', () => {
  const env=isolatedEnvironment({HOME:'/normal-home',USERPROFILE:'normal-profile'},'/state','/runtime/node');
  assert.equal(env.HOME,'/normal-home'); assert.equal(env.USERPROFILE,'normal-profile');
  assert.equal(env.DSWHALE_DATA_HOME,'/state'); assert.equal(env.DSH_NODE,'/runtime/node');
});

test('full upstream help map is reachable manually and comment assessment stays read-only',()=>{
  assert.deepEqual(validateCommand(['await','--minutes','1'],{manual:true}),['await','--minutes','1']);
  assert.deepEqual(validateCommand(['ai-share','sample','BV1234567890']),['ai-share','sample','BV1234567890']);
  assert.throws(()=>validateCommand(['ai-share','record','BV1234567890','/private/data']));
});

test('model video commands cannot escape state through positional output or BV names',()=>{
  for(const args of [
    ['watch-video','BV1234567890','3x3','/tmp/outside'],
    ['watch-video','BV1234567890','--tile','720','3x3','C:\\outside'],
    ['debrief','../../outside'], ['subtitles','../outside'], ['covers','BV1234567890','../outside']
  ]) assert.throws(()=>validateCommand(args));
  assert.deepEqual(validateCommand(['watch-video','BV1234567890','3x3','--tile','480','--uniform']),['watch-video','BV1234567890','3x3','--tile','480','--uniform']);
});
