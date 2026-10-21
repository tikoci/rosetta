# CLI Reference

> The CLI reference documents RouterOS command menus and properties by console path. Use this section to look up command syntax, configuration objects, and operational commands for RouterOS features.

# CLI Reference

The CLI reference documents RouterOS command menus and properties by console path. Use this section to look up command syntax, configuration objects, and operational commands for RouterOS features.

## Argument types

- **address** — universal address parameter, rendered as `address (flags=...)`; see [address flags](#address-flags) below
- **alt** — alternative type, can accept one of several different value types
- **as** — autonomous system number (used in BGP routing)
- **bool** — boolean value (true/false, yes/no)
- **cfg** — configuration entry identifier
- **composite** — combination of multiple arguments treated as a group
- **date** — date and time value
- **enum** — enumerator, has predefined values listed in parentheses
- **expr** — expression or condition (used in routing filters and scripting)
- **file** — file path or name reference
- **iface_enum** — interface selection list, can usually accept an interface name, or predefined values like `all`, `none`, `dynamic`, `slave`; values listed in braces
- **ipAddr** — IPv4 address
- **ip6Addr** — IPv6 address
- **ipPrefix** — IPv4 address with prefix length
- **ip6Prefix** — IPv6 address with prefix length
- **ipRange** — IPv4 address range
- **macAddr** — MAC address (can specify full address or with wildcards)
- **meter** — signal quality level, typically expressed in dBm
- **multi** — multi-value argument, accepts multiple values from a defined set
- **num** — unsigned integer, can be restricted with a range (e.g. `[3 .. 20]`, `[.. 10]`, `[4 ..]`); 32-bit range if not explicitly specified
- **numericon** — numeric value displayed with unit suffix
- **object** — structured list of values (e.g. a table of addresses or configuration items)
- **pic** — picture/bitmap value
- **range** — numeric range (e.g. a set of ports)
- **remote** — reference to a remote object (e.g. a routing filter rule)
- **script** — script source code; parameters rendered as `alt { script: string }` accept either the name of an existing script from `/system script`, or inline script source code
- **string** — text string
- **super** — composite type accepting multiple different argument types; sub-types are listed in braces, e.g. `super { bool, time }`
- **switch** — on/off toggle without an explicit value argument
- **time** — time duration or interval, usually in seconds, may include units like `s`, `m`, `h`, `d`
- **timezone** — timezone or UTC offset value
- **ubit** — bitfield with named bits, supported bit names listed in parentheses, e.g. `ubit (ip, ipv6)`
- **value** — standalone value identifier (typically used as part of a composite or enum)
- **varName** — variable name reference (used in scripting)

Argument types can be nested, for example `super {num, time, super {bool, ip}}`.

## Standard list entry properties

List menus (menus whose entries can be added, removed and reordered) share a set of properties and commands that behave the same way everywhere, so they are not repeated in the Argument tables of each menu page:

- **`comment`** — free-form text comment for the entry
- **`disabled`** — when `yes`, the entry is inactive but kept in the configuration; such entries are flagged with `X` in listings. The `enable` and `disable` commands toggle this state
- **`copy-from`** — argument of the `add` command: creates the new entry as a copy of an existing entry
- **`place-before`** — argument of the `add` and `move` commands: positions the entry before another entry in the list

## Standard print modifiers

The `print` command accepts output modifiers that are likewise not listed on each menu page:

- **`detail`** — prints all properties of each entry, instead of the brief summary
- **`as-value`** — returns the output as values rather than formatted strings, for use in scripts

## address-flags

The **address** type is rendered as `address (flags=...)` where the flags define which address formats are accepted:

| Flag | Meaning |
|------|---------|
| 4    | IPv4 address |
| 6    | IPv6 address |
| D    | DNS name (hostname) |
| i    | Interface name as the value itself, in place of an address (e.g. a point-to-point interface as a route gateway) |
| /    | Address with subnet mask (CIDR prefix) |
| v    | VRF (Virtual Routing and Forwarding instance) |
| %    | Interface suffix on an address (zone specifier), e.g. `fe80::1%ether1` or `00:11:22:33:44:55%ether1` |
| R    | Route distinguisher |
| S    | Free-form prefix (e.g. EVPN prefix) |
| \+   | Address list |
| :    | Port or zone specifier |
| L    | Link-local address |
| m    | multicast address |

The `i` and `%` flags differ in where the interface appears. With `i`, a bare interface name replaces the address. With `%`, the interface is only a qualifier appended to a complete address, used to disambiguate addresses that are not unique router-wide, such as IPv6 link-local addresses.

Note that the `%interface` suffix is part of the IPv6 link-local addressing itself: a link-local address is ambiguous without a zone specification, so any parameter that accepts IPv6 addresses (flag `6`) accepts `link-local%interface`, even if its flag list does not include `%`. The `%` flag indicates that the parameter supports the suffix more broadly, for example to select the outgoing interface for a MAC ping.
