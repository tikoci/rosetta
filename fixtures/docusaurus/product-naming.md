# Product Naming

> MikroTik product naming follows a structured convention for RouterBOARD models, detailing board series, wired/wireless interfaces, CPU cores, and wireless features like bands and power levels to help users identify hardware specifications quickly.

# Product Naming

## Introduction

MikroTik product naming can appear confusing at first glance, but all product codes follow a logical naming convention. Understanding this naming structure helps users identify key product features and specifications at a glance. This documentation explains the meaning behind each segment of MikroTik product codes and provides examples to help you decode any model number.

### RouterBOARD (short version RB)

`<board name> <board features>-<built-in wireless> <wireless card features>-<connector type>-<enclosure type>`

### Board Name

Currently, there can be three types of board names:

- **3-symbol name**:
  - 1st symbol stands for series (this can either be a number or a letter); New additions: D - Dakota; C - Cypress; S - Chateau; L - Maple; E - Econet; MA - Miami.
  - 2nd digit indicates the number of potential wired interfaces (Ethernet, SFP, SFP+).
  - 3rd digit indicates the number of potential wireless interfaces (built-in and mPCI and mPCIe slots).

- **Word** - Currently used names are: **OmniTIK, Groove, SXT, SEXTANT, Metal, LHG, DynaDish, cAP, wAP, LDF, DISC, mANTBox, QRT, hAP, hEX**. If the board has fundamental changes in hardware (such as a completely different CPU) a revision version will be added at the end.

- **Exceptional naming** - 600, 800, 1000, 1100, 1200, 2011, 3011, 4011 boards are standalone representatives of the series or have more than 9 wired interfaces, so the name was simplified to full hundreds or development year.

### Board Features

Board features appear immediately after the board name, with no spaces or dashes separating them. The exception is when the board name is a word; in this case, board features are separated by a space.

The following features are used, listed in the order they appear:

- **U** – USB port.
- **P** – Power injection with a controller.
- **i** – Single-port power injector without a controller.
- **A** – Additional memory and/or higher license level.
- **H** – More powerful CPU.
- **G** – Gigabit Ethernet (may be combined with U, A, or H; not used with L).
- **L** – Lite edition.
- **D** – Additional storage disk (SSD or M.2).
- **S** – SFP port (legacy usage for SwitchOS devices).
- **e** – PCIe interface extension card.
- **xN** – Number of CPU cores (for example, x2, x16, x36).
- **R** – MiniPCIe slot with both USB and PCIe lines.
- **M** – M.2 slot with both USB and PCIe lines.

### Built-in wireless details

If the board has built-in wireless, then all its features are represented in the following format:

`<band><power_per_chain><protocol><number_of_chains>`

- **band**:
  - **6** - 6GHz.
  - **5** - 5GHz.
  - **2** - 2.4GHz.
  - **52** - Dual-band 5GHz and 2.4GHz.

- **power per chain**:
  - (Not used) - "Normal" - &lt;23dBm at 6Mbps 802.11a. &lt;24dBm at 6Mbps 802.11g.
  - **H** - "High" - 23-24dBm at 6Mbps 802.11a. 24-27dBm at 6Mbps 802.11g.
  - **HP** - "High Power" - 25-26dBm 6Mbps 802.11a. 28-29dBm at 6Mbps 802.11g.
  - **SHP** - "Super High Power" - 27+dBm at 6Mbps 802.11a. 30+dBm at 6Mbps 802.11g.

- **protocol**:
  - (Not used) - For cards with only 802.11a/b/g support.
  - **n** - For cards with 802.11n support.
  - **ac** - For cards with 802.11ac support.
  - **ax** - For cards with 802.11ax support.
  - **be** - For cards with 802.11be support.
  - **bn** - For interfaces with 802.11bn support.

- **number\_of\_chains**:
  - (Not used) - Single chain.
  - **D** - Dual (2) chain.
  - **T** - Triple (3) chain.
  - **Q** - Quad (4) chain.
  - **P** - Penta (5) chain.
  - **H** - Hexa (6) chain.
  - **S** - Septa (7) chain.
  - **O** - Octa (8) chain.
  - **N** - Nona (9) chain.
  - **E** - “Ene” (10) chain (as D for "deca" is busy already).

- **connector type**:
  - (Not used) - only one connector option on the model.
  - **MMCX** - MMCX connector type.
  - **u.FL** - u.FL connector type.

### Enclosure type

- (Not used) - the main type of enclosure for a product.
- **BU** - board unit (no enclosure) - for a situation when a board-only option is required, but the main product already comes in the case.
- **RM** - rack-mount enclosure.
- **IN** - indoor enclosure.
- **EM** - extended memory.
- **LM** - lite memory.
- **BE** - black edition case.
- **TC** - Tower (vertical) case enclosure (for hEX, hAP and other home routers).
- **OUT** - outdoor enclosure.

## More Specific types OUT enclosures are

- **SA** - Sector antenna enclosure (for SXT).
- **HG** - High gain antenna enclosure (for SXT).
- **BB** - Basebox enclosure (for RB911).
- **NB** - NetBox enclosure (for RB911).
- **NM** - NetMetal enclosure (for RB911).
- **QRT** - QRT enclosure (for RB911).
- **SX** - Sextant enclosure (for RB911,RB711).
- **SXTsq -**SXTsq enclosure.
- **PB** - PowerBOX enclosure (for RB750P, RB950P).
- **XL** - Extra large enclosure (bigger size LHG for example).
- **LTm** - LtAP mini case.
- **LT** - LtAP case.
- **KN**- KNOT case.

### Example

- RB (RouterBOARD).
- 912 - 9th series board with 1 wired (ethernet) interface and two wireless interfaces (built-in and mini PCIe).
- UAG - has a USB port, more memory, and a gigabit ethernet port.
- 5HPnD - has a built-in 5GHz high power dual chain wireless card with 802.11n support.

## 2 decode [RBD52G-5HacD2HnD-TC](https://mikrotik.com/product/hap_ac2) naming

- RouterBOARD (deprecated in new products)
- D - Dakota series CPU
- 5 - wired interfaces
- 2 - wireless interfaces
- G - gigabit
- 5HacD - has built-in 5GHz high power dual chain wireless card with 802.11ac support.
- 2HnD  - has built-in 2.4GHz high power dual chain wireless card with 802.11n support.
- TC - tower case

## Example

# 3 decode [C52iG-5HaxD2HaxD-TC](https://mikrotik.com/product/hap_ax2) naming

- C - Cypress series CPU.
- 5 - Wired interfaces.
- 2 - Wireless interfaces.
- i - Single port power injector without controller.
- G - Gigabit.
- 5HaxD - Has built-in 5GHz high power dual chain wireless card with 802.11ax support.
- 2HaxD - Has built-in 2.4GHz high power dual chain wireless card with 802.11ax support.
- TC - Tower case.

## CloudCoreRouter naming details

CloudCoreRouter (short version: CCR) naming consists of:

`<4 digit number>-<list of ports>-<enclosure type>`

- **4 digit number**:
  - 1st digit stands for series.
  - 2nd (reserved).
  - 3rd-4th digits indicate the number of total CPU cores on the device.

- **List of ports**:
  - -n**G** Number of 1G Ethernet ports.
  - -n**P** Number of 1G Ethernet ports with PoE-out.
  - -n**C** Number of combo 1G Ethernet/SFP ports.
  - -n**S** Number of 1G SFP ports.
  - -n**G+** Number of 2.5G Ethernet ports.
  - -n**P+** Number of 2.5G Ethernet ports with PoE-out.
  - -n**C+** Number of combo 10G Ethernet/SFP+ ports.
  - -n**S+** Number of 10G SFP+ ports.
  - -n**XG** Number of 5G/10G Ethernet ports.
  - -n**XP** Number of 5G/10G Ethernet ports with PoE-out.
  - -n**XC** Number of combo 10G/25G SFP+ ports.
  - -n**XS** Number of 25G SFP+ ports.
  - -n**Q+** Number of 40G QSFP+ ports.
  - -n**XQ** Number of 100G QSFP+ ports.
  - -n**DQ**  Number of 200G QSFP56 ports.
  - -n**DDQ** Number of 400G QSFP-DD ports.

- **Enclosure type**  - Same as for RouterBOARD products.

## CloudRouterSwitch and CloudSmartSwitch naming details

CloudRouterSwitch (short version CRS, RouterOS device) and CloudSmartSwitch (short version CSS, SwOS device) naming consists of:

`<3 digit number>-<list of ports>-<built-in wireless card>-<enclosure type>`

- **3-digit number**:
  - 1st digit stands for series.
  - 2nd-3rd digit - Total number of wired interfaces (Ethernet, SFP, SFP+).

- **list of ports**:
  - -n**F** Number of 100M Ethernet ports.
  - -n**Fi** Number of 100M Ethernet ports with PoE-out injector.
  - -n**Fp** Number of 100M Ethernet ports with controlled PoE-out.
  - -n**Fr** Number of 100M Ethernet ports with Reverse PoE (PoE-in).
  - -n**G** Number of 1G Ethernet ports.
  - -n**P** Number of 1G Ethernet ports with PoE-out.
  - -n**C** Number of combo 1G Ethernet/SFP ports.
  - -n**S** Number of 1G SFP ports.
  - -n**G+** Number of 2.5G Ethernet ports.
  - -n**P+** Number of 2.5G Ethernet ports with PoE-out.
  - -n**C+** Number of combo 10G Ethernet/SFP ports.
  - -n**S+** Number of 10G SFP+ ports.
  - -n**XG** Number of 5G/10G Ethernet ports.
  - -n**XP** Number of 5G/10G Ethernet ports with PoE-out.
  - -n**XC** Number of combo 10G/25G SFP+ ports.
  - -n**XS** Number of 25G SFP+ ports.
  - -n**Q+** Number of 40G QSFP+ ports.
  - -n**XQ** Number of 100G QSFP+ ports.
  - n**DQ**  Number of 200G QSFP56 ports.
  - -n**DDQ** Number of 400G QSFP-DD ports.
  - `-nP` indicates PoE-out ports supporting IEEE 802.3af/at (PoE / PoE+).
  - -`<n>B` indicates PoE-out ports supporting IEEE 802.3af/at/bt (includes PoE++ / 802.3bt high-power PoE).

- **built-in wireless card** - same as for RouterBOARD products.

- **enclosure type** - same as for RouterBOARD products.
