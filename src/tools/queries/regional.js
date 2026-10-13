/** Malaysia MET alerts, modelled air quality and infrastructure investigation. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

/** Map a bridge failure to the tool error a client should see. */
function bridgeError(error) {
  if (error?.status === 400)
    return new ToolError('invalid_arguments', error.message);
  if (error?.status === 403 || error?.status === 401)
    return new ToolError('unsupported', error.message);
  if (error?.status === 429) return new ToolError('retry_later', error.message);
  if (error?.status === 503)
    return new ToolError(
      'unavailable',
      'Investigation is not enabled on this server',
    );
  return new ToolError(
    'unavailable',
    'The investigation service is unavailable',
  );
}

export const getMalaysiaAlerts = defineTool({
  name: 'get_malaysia_alerts',
  title: 'Malaysia MET alerts',
  description:
    'Earthquakes reported by MET Malaysia in the last 30 days (strongest ' +
    'first) and the weather warnings currently in force, from the ' +
    'data.gov.my open API. Warnings are text only; they have no coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      min_magnitude: { type: 'number', minimum: 0, maximum: 10 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['malaysiaMet'],
  async run(args, { services, signal }) {
    const summary = await services.malaysiaMet.getSummary({ signal });
    const minimum = args.min_magnitude ?? 0;
    const quakes = (summary.earthquakes || [])
      .filter((quake) => (quake.magnitude ?? 0) >= minimum)
      .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));
    const warnings = summary.warnings || [];
    const result = capRows(quakes, args.limit);
    return {
      summary:
        `${countNoun(quakes.length, 'MET-reported earthquake')} in the last 30 days` +
        (minimum ? ` of M${minimum}+` : '') +
        `; ${countNoun(warnings.length, 'weather warning')} in force.`,
      data: {
        view: suggestView(services, {
          point: { lat: 4.2, lon: 108 },
          altitudeM: 2_500_000,
          layers: ['malaysia-met'],
        }),
        ...result,
        rows: result.rows.map((quake) => ({
          id: quake.id,
          magnitude: quake.magnitude,
          place: quake.place,
          distance_from_malaysia: quake.distanceFromMalaysia,
          depth_km: quake.depthKm,
          time: isoTime(quake.timeMs),
          lat: quake.lat,
          lon: quake.lon,
        })),
        warnings: warnings.map((warning) => ({
          title: warning.title,
          valid_from: isoTime(warning.validFromMs),
          valid_to: isoTime(warning.validToMs),
          text: warning.text,
          instruction: warning.instruction,
        })),
        source: 'MET Malaysia via data.gov.my',
      },
    };
  },
});

export const getAirQuality = defineTool({
  name: 'get_air_quality',
  title: 'Air quality (modelled)',
  description:
    'Modelled current air quality (US AQI, PM2.5, PM10) for Malaysian ' +
    'cities and the regional haze-source cities in Sumatra and Borneo, from ' +
    'the Open-Meteo CAMS model. These are coarse-grid model values, not ' +
    'station readings, and nearby cities can share a value.',
  inputSchema: {
    type: 'object',
    properties: {
      group: { type: 'string', enum: ['malaysia', 'region', 'all'] },
      min_aqi: { type: 'integer', minimum: 0, maximum: 500 },
      limit: LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requires: ['airQuality'],
  async run(args, { services, signal }) {
    const summary = await services.airQuality.getSummary({ signal });
    const group = args.group ?? 'malaysia';
    const minimum = args.min_aqi ?? 0;
    const cities = (summary.cities || [])
      .filter(
        (city) =>
          (group === 'all' || city.group === group) && city.usAqi >= minimum,
      )
      .sort((a, b) => b.usAqi - a.usAqi);
    const result = capRows(cities, args.limit);
    const worst = cities[0]
      ? `; highest ${cities[0].name} at US AQI ${cities[0].usAqi}`
      : '';
    return {
      summary: `${countNoun(cities.length, 'city', 'cities')} (${group})${minimum ? ` at US AQI ${minimum}+` : ''}${worst}. Modelled values, not station readings.`,
      data: {
        view: suggestView(services, {
          point: { lat: 3, lon: 107 },
          altitudeM: 3_000_000,
          layers: ['air-quality'],
        }),
        ...result,
        rows: result.rows.map((city) => ({
          id: city.id,
          name: city.name,
          group: city.group,
          us_aqi: city.usAqi,
          pm2_5: city.pm25,
          pm10: city.pm10,
          time: isoTime(city.timeMs),
          lat: city.lat,
          lon: city.lon,
        })),
        model: summary.model,
      },
    };
  },
});

export const investigateTarget = defineTool({
  name: 'investigate_target',
  kind: 'action',
  title: 'Investigate infrastructure',
  description:
    'Start a SpiderFoot scan of an infrastructure target: a domain, public ' +
    'IPv4 address, netblock of /24 or smaller, or AS number such as AS4788. ' +
    'Scans are passive by default. Targets that identify a person (e-mail ' +
    'addresses, phone numbers, names, usernames) and private addresses are ' +
    'refused. Returns a scan id; read it with get_investigation.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', minLength: 3, maxLength: 253 },
      mode: { type: 'string', enum: ['passive', 'footprint', 'investigate'] },
    },
    required: ['target'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  requires: ['investigate'],
  async run(args, { services, signal }) {
    let started;
    try {
      started = await services.investigate.start({
        target: args.target,
        mode: args.mode,
        signal,
      });
    } catch (error) {
      throw bridgeError(error);
    }
    return {
      summary: `Started a ${started.mode} scan of ${started.target.kind} ${started.target.value}. Scan id ${started.scanId}; read it with get_investigation.`,
      data: {
        scan_id: started.scanId,
        target: started.target,
        mode: started.mode,
      },
    };
  },
});

export const getInvestigation = defineTool({
  name: 'get_investigation',
  title: 'Investigation results',
  description:
    'Read a SpiderFoot scan started with investigate_target: its status and ' +
    'a per-type summary, or the findings of one event type such as ' +
    'INTERNET_NAME, IP_ADDRESS or RAW_RIR_DATA.',
  inputSchema: {
    type: 'object',
    properties: {
      scan_id: { type: 'string', minLength: 4, maxLength: 64 },
      event_type: { type: 'string', pattern: '^[A-Z0-9_]{2,64}$' },
      limit: LIMIT_SCHEMA,
    },
    required: ['scan_id'],
    additionalProperties: false,
  },
  requires: ['investigate'],
  async run(args, { services, signal }) {
    try {
      if (!args.event_type) {
        const status = await services.investigate.status({
          id: args.scan_id,
          signal,
        });
        return {
          summary: `Scan ${args.scan_id} is ${status.status}${status.finished ? '' : ' (still running)'}; ${countNoun(status.summary.length, 'event type')} found so far.`,
          data: {
            scan_id: status.id,
            target: status.target,
            status: status.status,
            finished: status.finished,
            event_types: status.summary,
          },
        };
      }
      const found = await services.investigate.results({
        id: args.scan_id,
        type: args.event_type,
        signal,
      });
      const result = capRows(found.events || [], args.limit);
      return {
        summary: `${countNoun(found.events?.length ?? 0, 'finding')} of type ${args.event_type} in scan ${args.scan_id}.`,
        data: { scan_id: args.scan_id, event_type: args.event_type, ...result },
      };
    } catch (error) {
      throw bridgeError(error);
    }
  },
});
