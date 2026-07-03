const { test } = require("node:test");
const assert = require("node:assert");
const { buildTemplate } = require("../scripts/generate-cloudfront-template");

test("generates one origin + behavior + function per region", () => {
  const tpl = buildTemplate(["ap-northeast-1", "eu-west-1"], "location-proxy/api-keys");
  // CloudFront Function per region, each resolving its own region key
  assert.match(tpl, /ApNortheast1AppendKeyFunction/);
  assert.match(tpl, /EuWest1AppendKeyFunction/);
  assert.match(tpl, /SecretString:ap-northeast-1/);
  assert.match(tpl, /SecretString:eu-west-1/);
  // path-prefixed cache behavior per region
  assert.match(tpl, /PathPattern: \/ap-northeast-1\/\*/);
  assert.match(tpl, /PathPattern: \/eu-west-1\/\*/);
  // origin domain per region
  assert.match(tpl, /maps\.geo\.ap-northeast-1\.amazonaws\.com/);
  assert.match(tpl, /maps\.geo\.eu-west-1\.amazonaws\.com/);
});

test("edge function strips the region path prefix before forwarding", () => {
  const tpl = buildTemplate(["eu-west-1"], "s");
  assert.match(tpl, /request\.uri = request\.uri\.slice\('\/eu-west-1'\.length\);/);
});

test("policy suffix makes account-global policy names unique", () => {
  const tpl = buildTemplate(["eu-west-1"], "s", "ab12cd");
  assert.match(tpl, /Name: !Sub "\$\{AWS::StackName\}-MapTileCache-ab12cd"/);
  assert.match(tpl, /Name: !Sub "\$\{AWS::StackName\}-ForwardApiKey-ab12cd"/);
});

test("no suffix keeps the base policy names (backward compatible)", () => {
  const tpl = buildTemplate(["eu-west-1"], "s");
  assert.match(tpl, /Name: !Sub "\$\{AWS::StackName\}-MapTileCache"/);
  assert.match(tpl, /Name: !Sub "\$\{AWS::StackName\}-ForwardApiKey"/);
});
