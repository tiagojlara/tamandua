# Tamandua charts

Draws a chart inside the Tamandua MCP tool cards instead of the generic tool row. Three tools are covered:

- `mcp__tamandua__get_summary` — portfolio value by currency, with asset and account counts. Amounts are never converted between currencies.
- `mcp__tamandua__get_cash_flow_summary` — income, spending and net per currency for the month, then spending by category.
- `mcp__tamandua__list_dividends` — dividends received per year, grouped from the rows that query returned.

The chart reads the tool result that already reached the transcript, so it adds no request, no credential and no second data path. It requires the Tamandua MCP connection (`@local/tamandua-mcp`) and the app running on port 3000.

## Limits

- Only a successful JSON result draws a chart. An error or an empty result keeps a short notice instead.
- The dividends chart covers the rows the call returned; it is not the account's full history unless the query fetched it.
- The raw result is not shown in the row; it remains in the session log and the trajectory view.
