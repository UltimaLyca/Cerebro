# Investigation bridge

Cerebro can start and read [SpiderFoot](https://github.com/smicallef/spiderfoot)
(MIT) scans of **infrastructure**: domains and hostnames, public IPv4
addresses, netblocks of /24 or smaller, and AS numbers (`AS4788`). It is a
server API; there is no map panel yet.

It is off by default. Set both `SPIDERFOOT_URL` (a SpiderFoot 4.x started with
`sf.py -l host:port`) and `INVESTIGATE_TOKEN` (a long shared secret). Every
request must send the secret as `x-investigate-token`; without it the endpoint
answers 401, so a public deployment cannot be used to start scans.
`docker/docker-compose.spiderfoot.yml` runs SpiderFoot as a sidecar with no
published port, because SpiderFoot's own UI has no login.

## What it refuses

SpiderFoot also scans e-mail addresses, phone numbers, usernames, personal
names and Bitcoin addresses. The bridge rejects all of those, plus private,
loopback and link-local addresses and local names, before anything reaches
SpiderFoot (`server/providers/spiderfoot/target.js`). It is for looking at
infrastructure and organisations, not individuals.

Scans use SpiderFoot's `passive` use case, which gathers from third-party
sources without touching the target. `footprint` and `investigate` contact the
target and are refused unless `SPIDERFOOT_ALLOW_ACTIVE=1`; only enable that for
targets you are authorised to scan. At most three scans run at once.

## Endpoints

| Request                                        | Result                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `POST /api/investigate/scan` `{target, mode?}` | `202 {scanId, target, mode}`               |
| `GET /api/investigate/scan?id=`                | status, `finished`, and a per-type summary |
| `GET /api/investigate/results?id=&type=`       | up to 500 condensed events                 |
| `POST /api/investigate/stop` `{id}`            | `{stopped: true}`                          |

From an assistant, the MCP server offers `investigate_target` and
`get_investigation` when `INVESTIGATE_TOKEN` is in its environment; see
[Tools](TOOLS.md).

The tests (`node --test server/providers/spiderfoot.test.mjs
server/providers/spiderfoot/target.test.mjs`) run against a fake SpiderFoot
that reproduces the response shapes in SpiderFoot's `sfwebui.py`. They are not
in `npm test`, which only discovers tests under `src/`. I have not run the
bridge against a live SpiderFoot.
