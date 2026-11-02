// The ZATLA grow light as the site describes it. One place for the name, price
// and figures the shop page and the home page both show, so they never drift.
// Figures are the ones already in the app, from the Zatla product sheet at full
// power (1000 W fixture).
export const PRODUCT = {
  name: "ZATLA Grow Light",
  price: 750,                    // USD
  currency: "USD",
  description:
    "A commercial-grade, full-spectrum LED fixture designed for high-efficiency cannabis cultivation, delivering even canopy coverage and tunable spectrum control.",
  features: [
    "Full-spectrum LED with UVA, blue, red and far-red channels",
    "High-efficiency output for uniform canopy PPFD",
    "Tunable spectrum for veg and flower stages",
    "Built for commercial rolling benches and multi-tier racks",
    "Passive cooling with commercial-grade housing",
  ],
  specs: [
    { label: "Power", value: "1,000", unit: "W" },
    { label: "Efficacy", value: "3.26", unit: "µmol/J" },
    { label: "Photon flux", value: "3,010", unit: "µmol/s" },
    { label: "Peak PPFD at 12 in", value: "1,962", unit: "µmol/m²/s" },
    { label: "Input", value: "240 / 277", unit: "V" },
  ],
};

export const formatPrice = (n) => `$${n.toLocaleString("en-US")}`;
