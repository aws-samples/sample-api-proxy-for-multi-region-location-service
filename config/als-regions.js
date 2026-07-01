// ALS v2 (GeoPlaces / GeoMaps) supported commercial regions.
// Source: AWS Location Service endpoints & quotas.
const ALS_SUPPORTED_REGIONS = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-5",
  "ap-south-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-north-1",
  "eu-south-2",
  "sa-east-1",
  "ca-central-1",
]);

// Regions whose data provider is GrabMaps (SE-Asia optimized, NOT global
// coverage). Must NOT be used as the reverse-geocode guide region.
const GRABMAPS_REGIONS = new Set(["ap-southeast-1", "ap-southeast-5"]);

module.exports = { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS };
