# Source gaps

A comparison of the public data sources Cerebro does not yet use, drawn from
the source list ShadowBroker publishes in its `DATA-ATTRIBUTION.md` (checked
2026-10-13). Only that list of public data providers was used. ShadowBroker is
AGPL-3.0 and Cerebro is MIT, so none of its code was read, copied or adapted;
any source below must be implemented from the provider's own documentation.

Terms are each provider's; read them before use.

| Source                       | Would add                    | Access                                         | Notes                                                                                                                   |
| ---------------------------- | ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OpenAQ                       | Station-measured air quality | Free API key required (`X-API-Key`), CC BY 4.0 | Would replace the modelled `air-quality` layer's values with measurements where stations exist. Not built: needs a key. |
| NOAA SWPC                    | Space weather, Kp index      | Public domain                                  | Low value for Malaysia.                                                                                                 |
| Smithsonian GVP              | Volcanoes                    | Attribution required                           | Relevant to Indonesia's haze and ash.                                                                                   |
| Global Fishing Watch         | Fishing-vessel activity      | CC BY 4.0 for public data; token               | Straits of Malacca and Sulu Sea relevance.                                                                              |
| IODA (Georgia Tech)          | Internet outages             | Research terms                                 | Useful as a regional outage signal.                                                                                     |
| KiwiSDR list                 | Public SDR receivers         | Community mirror                               | Pairs with local-receiver work.                                                                                         |
| Meshtastic map               | Mesh radio nodes             | Community API, poll gently                     |                                                                                                                         |
| WRI Global Power Plant DB    | Power plants                 | CC BY 4.0                                      | Static; fits the datacenter/dam layers.                                                                                 |
| GDELT events                 | Geolocated events            | CC BY                                          | Cerebro uses GDELT DOC only for headlines.                                                                              |
| Copernicus CDSE / Sentinel-2 | Imagery, SAR                 | ESA open data                                  | Heavy; needs an account.                                                                                                |

Already covered by Cerebro: OpenSky, adsb.lol, CelesTrak, USGS, NASA GIBS and
FIRMS, AISStream, NOAA/NWS, GDELT DOC, Open-Meteo, OpenStreetMap.

Built from this gap list: `air-quality` (Open-Meteo/CAMS, keyless, modelled)
because OpenAQ needs a key.
