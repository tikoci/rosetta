# Sample

> -----------

import {ArgTableRow} from '@site/src/components/common';
import {ArgTable} from '@site/src/components/common';

-----------

## ip/address

**Conditions:** !smips
**Type:** Directory

The address directory holds IPv4 addresses. This paragraph is entry prose that must
survive extraction verbatim, including a list:

- one
- two

<ArgTable c1="Flag" c2="Name" c3="Description">
<ArgTableRow arg="X" typ="disabled">disabled</ArgTableRow>
<ArgTableRow arg="D" typ="dynamic">dynamic</ArgTableRow>
</ArgTable>

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="address" typ="composite { ,  }" mandatory="1"></ArgTableRow>
<ArgTableRow arg="interface" typ="iface_enum" mandatory="1">Interface the address sits on.
Second line of the same description, which must not be whitespace-flattened.</ArgTableRow>
</ArgTable>

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="actual-interface" typ="iface_enum">Resolved interface.</ArgTableRow>
</ArgTable>

### ip/address/print

**Type:** Command

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="count-only" typ="bool" unset="1"></ArgTableRow>
</ArgTable>

## disk

**Syscap:** storage
**Package:** system
**Type:** Settings Directory

A settings directory with a fenced transcript whose row-number header is a false heading,
and example markup that must NOT be parsed as structure:

```text
Columns: NAME
#   NAME
0   disk1
**Package:** not-a-real-gate
<ArgTable c1="Argument"><ArgTableRow arg="fake" typ="x">nope</ArgTableRow></ArgTable>
```

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="slot" typ="string" syscap="storage"></ArgTableRow>
</ArgTable>
