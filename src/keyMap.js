// Parse the LOCATION_API_KEYS secret (JSON string of {region: apiKey}) into a Map.
function parseKeyMap(jsonString) {
  if (!jsonString) {
    throw new Error("LOCATION_API_KEYS is not set");
  }
  let obj;
  try {
    obj = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`LOCATION_API_KEYS is not valid JSON: ${e.message}`);
  }
  return new Map(Object.entries(obj));
}

module.exports = { parseKeyMap };
