// Per-region default map view: a representative city center [lng, lat] + zoom.
// Drives BOTH the initial map view AND the search BiasPosition, so the bias is
// always inside the region's coverage. This matters for GrabMaps regions
// (ap-southeast-1 / ap-southeast-5): a bias outside their Southeast-Asia
// coverage returns ZERO results, not just lower-ranked ones.
//
// Coordinates are [longitude, latitude] (GeoJSON / ALS order).
const REGION_CENTERS = {
  "us-east-1": { center: [-77.04, 38.9], zoom: 4 }, // Washington, DC
  "us-east-2": { center: [-82.99, 39.96], zoom: 4 }, // Columbus, OH
  "us-west-2": { center: [-122.33, 47.61], zoom: 4 }, // Seattle, WA
  "ca-central-1": { center: [-79.38, 43.65], zoom: 4 }, // Toronto
  "sa-east-1": { center: [-46.63, -23.55], zoom: 4 }, // São Paulo
  "eu-west-1": { center: [-6.26, 53.35], zoom: 4 }, // Dublin
  "eu-west-2": { center: [-0.13, 51.51], zoom: 4 }, // London
  "eu-central-1": { center: [8.68, 50.11], zoom: 4 }, // Frankfurt
  "eu-south-2": { center: [-3.7, 40.42], zoom: 4 }, // Madrid (Spain)
  "eu-north-1": { center: [18.07, 59.33], zoom: 4 }, // Stockholm
  "ap-south-1": { center: [72.88, 19.08], zoom: 4 }, // Mumbai
  "ap-northeast-1": { center: [139.77, 35.68], zoom: 4 }, // Tokyo
  "ap-southeast-1": { center: [103.82, 1.35], zoom: 5 }, // Singapore (GrabMaps)
  "ap-southeast-2": { center: [151.21, -33.87], zoom: 4 }, // Sydney
  "ap-southeast-5": { center: [101.69, 3.14], zoom: 5 }, // Kuala Lumpur (GrabMaps)
};

// Neutral world view for regions with no specific entry.
const DEFAULT_CENTER = { center: [0, 0], zoom: 1 };

function regionCenter(region) {
  return REGION_CENTERS[region] || DEFAULT_CENTER;
}

module.exports = { REGION_CENTERS, DEFAULT_CENTER, regionCenter };
