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

test("functions are chained with DependsOn to serialize creation (avoid rate limit)", () => {
  const tpl = buildTemplate(["ap-northeast-1", "eu-west-1", "us-east-1"], "s");
  // first function has no DependsOn; each subsequent one depends on the prior.
  assert.match(tpl, /EuWest1AppendKeyFunction:\n\s+Type: AWS::CloudFront::Function\n\s+DependsOn: ApNortheast1AppendKeyFunction/);
  assert.match(tpl, /UsEast1AppendKeyFunction:\n\s+Type: AWS::CloudFront::Function\n\s+DependsOn: EuWest1AppendKeyFunction/);
  // the first one must NOT carry a DependsOn
  assert.doesNotMatch(tpl, /ApNortheast1AppendKeyFunction:\n\s+Type: AWS::CloudFront::Function\n\s+DependsOn/);
});

test("single region has no DependsOn", () => {
  const tpl = buildTemplate(["eu-west-1"], "s");
  assert.doesNotMatch(tpl, /DependsOn/);
});

test("DefaultCacheBehavior points at the home region, not regions[0]", () => {
  // regions[0] is eu-west-1, but home is us-east-1 → default must use home.
  const tpl = buildTemplate(["eu-west-1", "us-east-1"], "s", "", "us-east-1");
  const defaultBlock = tpl.slice(
    tpl.indexOf("DefaultCacheBehavior:"),
    tpl.indexOf("CacheBehaviors:")
  );
  assert.match(defaultBlock, /TargetOriginId: UsEast1Origin/);
  assert.match(defaultBlock, /UsEast1AppendKeyFunction/);
  assert.doesNotMatch(defaultBlock, /EuWest1Origin/);
});

test("home region defaults to regions[0] when not specified", () => {
  const tpl = buildTemplate(["eu-west-1", "us-east-1"], "s");
  const defaultBlock = tpl.slice(
    tpl.indexOf("DefaultCacheBehavior:"),
    tpl.indexOf("CacheBehaviors:")
  );
  assert.match(defaultBlock, /TargetOriginId: EuWest1Origin/);
});

test("distribution enables HTTP/2 and HTTP/3 for viewers (default is http1.1)", () => {
  const tpl = buildTemplate(["eu-west-1"], "s");
  assert.match(tpl, /HttpVersion: http2and3/);
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
