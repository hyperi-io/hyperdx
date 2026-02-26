// DFE Query Export Router
// Renders SQL from a HyperDX chart config or saved search for use
// as a DFE Rule. Returns both the structured config and the rendered SQL.
//
// This is a NEW file — it does not modify any upstream HyperDX files.

import { parameterizedQueryToSql } from '@hyperdx/common-utils/dist/clickhouse';
import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import { getMetadata } from '@hyperdx/common-utils/dist/core/metadata';
import { renderChartConfig } from '@hyperdx/common-utils/dist/core/renderChartConfig';
import { format } from '@hyperdx/common-utils/dist/sqlFormatter';
import {
  ChartConfigWithOptDateRange,
  SavedChartConfigSchema,
} from '@hyperdx/common-utils/dist/types';
import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import { getConnectionById } from '@/controllers/connection';
import { getSource } from '@/controllers/sources';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import logger from '@/utils/logger';

const router = express.Router();

const exportSqlSchema = z.object({
  body: z.object({
    // The chart config to render — same shape as a dashboard tile config
    chartConfig: SavedChartConfigSchema,
    // Optional date range for the query (millisecond timestamps)
    startTime: z.number().optional(),
    endTime: z.number().optional(),
  }),
});

/**
 * POST /dfe/export-sql
 *
 * Renders SQL from a chart config for use as a DFE Rule.
 *
 * Request body:
 *   - chartConfig: SavedChartConfig (same structure as dashboard tiles)
 *   - startTime?: number (ms timestamp, optional)
 *   - endTime?: number (ms timestamp, optional)
 *
 * Response:
 *   - sql: string (formatted, executable SQL)
 *   - config: SavedChartConfig (original config, for structured consumption)
 *   - source: { name, kind, tableName, connection }
 */
router.post(
  '/export-sql',
  validateRequest(exportSqlSchema),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { chartConfig, startTime, endTime } = req.body;

      // Resolve the source to get table and connection info
      const source = await getSource(teamId.toString(), chartConfig.source);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }

      // Resolve the connection for ClickHouse access
      const connectionId =
        typeof source.connection === 'string'
          ? source.connection
          : source.connection.toString();
      const connection = await getConnectionById(
        teamId.toString(),
        connectionId,
        false,
      );

      // Build the full chart config with optional date range
      const fullConfig: ChartConfigWithOptDateRange = {
        ...chartConfig,
        ...(startTime && endTime
          ? {
              dateRange: [new Date(startTime), new Date(endTime)],
            }
          : {}),
      };

      // Create a ClickHouse client to fetch metadata
      const clickhouseClient = new ClickhouseClient({
        host: connection?.host || 'http://localhost:8123',
        username: connection?.username,
        password: connection?.password,
      });

      const metadata = getMetadata(clickhouseClient);
      const querySettings = source.querySettings;

      // Render the chart config to SQL
      const chSql = await renderChartConfig(
        fullConfig,
        metadata,
        querySettings,
      );

      // Format the SQL for readability
      const rawSql = parameterizedQueryToSql(chSql);
      let formattedSql: string;
      try {
        formattedSql = format(rawSql);
      } catch {
        // If formatting fails, return raw SQL
        formattedSql = rawSql;
      }

      return res.json({
        sql: formattedSql,
        rawSql,
        config: chartConfig,
        source: {
          name: source.name,
          kind: source.kind,
          from: source.from,
          connection: connectionId,
        },
      });
    } catch (err) {
      logger.error({ err }, 'DFE: export-sql failed');
      next(err);
    }
  },
);

export default router;
