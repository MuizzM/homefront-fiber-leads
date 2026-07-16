// Sanitized real Kinetic Search API response for 345 James Allgood Dr, Inman, SC
// 29349 — the FRESH_LEAD regression fixture. `uqualProvisioningResult` is a JSON
// STRING (exactly as Kinetic sends it) and carries a COPPER "NO QUAL / REMOVE
// FIBER AREA" override alongside a separately-qualified FIBER (FTTP, 2 Gig)
// service. The address is a genuine NEW FIBER + billing N exact match.
export const KINETIC_345_JAMES_ALLGOOD = {
  success: true,
  validationResult: "AddressFound",
  errorCode: 0,
  exactMatch: true,
  techType: "FIBER",
  maxQual: "QUAL UP TO 2 GIG RANGE",
  dfAddressId: "DF-345-JAMES-ALLGOOD",
  qualAddressAccessId: "ACC-345-JA-0001",
  exchangeId: "INMNSCXA",
  fiberFastFlag: true,
  broadbandService: { finalQualSpeed: "2000000" },
  address: {
    addressLine1: "345 JAMES ALLGOOD DR",
    city: "INMAN",
    stateProvinceCd: "SC",
    postalCd: "29349",
    geoLat: "35.020537",
    geoLong: "-82.078668",
    addressCatalogDt: "2024-11-02",
    householdSegmentType: "NEW FIBER",
    marketSegmentType: "RESIDENTIAL",
    maxQualTechnologyType: "FIBER",
    billingStatus: "N",
    dfAddressIdXref: "XREF-345-JA",
    exchangeId: "INMNSCXA",
  },
  // Kinetic sends this nested payload as a JSON STRING.
  uqualProvisioningResult: JSON.stringify({
    broadBandServices: [
      { technologyType: "FIBER", finalQual: "QUAL UP TO 2 GIG RANGE", finalQualSpeed: 2000000, chipSetType: "FTTP", productID: 2347 },
      { technologyType: "COPPER", qualMessage: "NO QUAL", reasonDetails: "COPPER QUAL REMOVE FIBER AREA" },
    ],
    miror: { svcKey: "SVC-345JA-FTTP", status: "AVAILABLE" },
    overrides: [
      { technologyType: "COPPER", qualMessage: "NO QUAL", reasonDetails: "COPPER QUAL REMOVE FIBER AREA" },
    ],
  }),
};
