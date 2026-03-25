---
description: "Search RouterOS documentation using the MCP server. Finds pages, properties, and command tree entries."
agent: agent
tools: [mikrotik-docs/*]
---
Search the RouterOS documentation for: $input

Use the mikrotik-docs MCP tools to find relevant information:
1. Start with `routeros_search` for general queries
2. Use `routeros_lookup_property` for specific property names
3. Use `routeros_command_tree` to explore command hierarchy
4. Use `routeros_get_page` to read full page content when needed

Summarize findings with relevant URLs to help.mikrotik.com.
