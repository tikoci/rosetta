# VETH

> VETH (Virtual Ethernet) provides network connectivity for containers in RouterOS, acting as a virtual interface that supports static and DHCP-assigned IPs, SLAAC, and can be integrated into bridges or routing setups.

# VETH

VETH (Virtual Ethernet) is a virtual network interface that provides network connectivity for containers. It functions as a virtual Ethernet port that connects RouterOS to a container, enabling the container to communicate with other interfaces and networks.

VETH interfaces behave like standard Ethernet interfaces. They can be assigned static IPv4 and IPv6 addresses, obtain addresses via a DHCP client, and support SLAAC. Additionally, VETH interfaces can participate in bridge or routing configurations, just like physical interfaces.

## Basic Configuration Example

There are multiple ways to configure VETH. Below are simple examples.

```ros
# VETH with DHCP-client
/interface/veth/add dhcp=yes

# VETH with static address
/interface/veth/add address=10.1.1.10/24 gateway=10.1.1.1 
```

After configuring the interface, you can assign it to a container.  
The container should obtain either the IP assigned by the DHCP server or the static address.

## Properties

### VETH

**Sub-menu:** `/interface/veth/add`

Configuration settings for the VETH interface.

| Parameter | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| **address** | IPv4/IPv6 address | **None** | IPv4 or IPv6 address that will be assigned to the interface |
| **gateway** | IPv4 address | **None** | IPv4 gateway address |
| **gateway6** | IPv6 address | **None** | IPv6 gateway address |
| **mac-address** | MAC address | **None** | Interface MAC address |
| **container-mac-address** | MAC address | **None** | MAC address that will be assigned to the container |
| **dhcp** | yes / no | **no** | Enables DHCP client on the interface |
| **name** | string | **None** | Interface name |
