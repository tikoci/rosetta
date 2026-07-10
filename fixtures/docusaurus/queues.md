# Queues

> This page introduces MikroTik RouterOS queueing and bandwidth management, covering HTB, PCQ, burst behavior, and queue types for traffic shaping. It explains how to configure simple and advanced queues using `/queue/simple` and `/queue/tree`, with details on rate limiting principles, CIR/MIR definitions, and warnings about queue order and target matching.

import DocCardList from '@theme/DocCardList';

# Queues

This section covers RouterOS queueing and bandwidth management. Use it to configure HTB, PCQ, burst behavior, queue sizes, and queue types for traffic shaping.

<DocCardList />

## Overview

A queue is a collection of data packets collectively waiting to be transmitted by a network device using a pre-defined structure methodology. Queuing works almost on the same methodology used at banks or supermarkets, where the customer is treated according to their arrival.

Queues are used to:

- Limit data rate for certain IP addresses, subnets, protocols, ports, etc.
- Limit peer-to-peer traffic.
- Packet prioritization.
- Configure traffic bursts for traffic acceleration.
- Apply different time-based limits.
- Share available traffic among users equally, or depending on the load of the channel.

Queue implementation in MikroTik RouterOS is based on Hierarchical Token Bucket (HTB). HTB allows the creation of a hierarchical queue structure and determines relations between queues. These hierarchical structures can be attached at two different places. The [Packet Flow diagram](../packet-flow-in-routeros.md) illustrates both *input* and *postrouting* chains.

There are two different ways to configure queues in RouterOS:

- `/queue/simple` menu - designed to ease the configuration of simple, everyday queuing tasks (such as single client upload/download limitation, p2p traffic limitation, etc.).
- `/queue/tree` menu - for implementing advanced queuing tasks (such as global prioritization policy, and `/user/group` limitations). Requires marked packet flows from [`/ip/firewall/mangle`](../firewall/mangle.md) facility.

RouterOS provides a possibility to configure queues in 8 levels -  the first level is an interface queue from the `/queue/interface` menu and the other 7 are lower-level queues that can be created in Queue Simple and/or Queue Tree.

### Rate limitation principles

Rate limiting is used to control the rate of traffic flow sent or received on a network interface. Traffic with a rate that is less than or equal to the specified rate is sent, whereas traffic that exceeds the rate is dropped or delayed.

Rate limiting can be performed in two ways:

1. Discard all packets that exceed the rate limit – ***rate-limiting (dropper or shaper)*** *(100% rate limiter when queue-size=0)*.
2. Delay packets that exceed the specific rate limit in the queue and transmit them when it is possible – ***rate equalizing (scheduler)*** (100% rate equalizing when *queue-size=unlimited*).

The next figure explains the difference between *rate limiting* and rate *equalizing*:

![](./img/queues-01.webp)

As you can see in the first case, all traffic exceeds a specific rate and is dropped. In another case, traffic exceeds a specific rate and is delayed in the queue and transmitted later when it is possible, but note that the packet can be delayed only while the queue is not full. If there is no more space in the queue buffer, packets are dropped.

For each queue we can define two rate limits:

- **CIR** (Committed Information Rate) – (**limit-at** in RouterOS) In a worst-case scenario, the flow will get this amount of traffic rate regardless of other traffic flows. At any given time, the bandwidth should not fall below this committed rate.
- **MIR** (Maximum Information Rate) – (**max-limit** in RouterOS) In a best-case scenario, the maximum available data rate for the flow, if there is any free part of the bandwidth.

## Simple Queue

**Sub-menu:** `/queue/simple`

A simple queue is a plain way to limit traffic for a particular target. Also, you can use simple queues to build advanced QoS applications. They have useful integrated features:

- Peer-to-peer traffic queuing.
- Applying queue rules at chosen time intervals.
- Prioritization.
- Using multiple packet marks from *`/ip/firewall/mangle`*.
- Traffic shaping (scheduling) of bidirectional traffic (one limit for the total of upload + download).

:::warning
Simple queues have a strict order - each packet must go through every queue until it reaches one queue whose conditions fit packet parameters or until the end of the queue list is reached. For example, in the case of 1000 queues, a packet for the last queue will need to proceed through 999 queues before it will reach the destination.

:::

:::warning
Simple queue target matches packets based on src and dst address. If src address matches target, then this is upload; if dst matches target, then this is download. However, if you have a connection where src and dst both match the target, then such packets will always be counted as download since both of them match dst (for each individual packet in both directions), which in RouterOS is simply the first thing compared to the target. Simple queue should be configured in a way that traffic can match only src or dst address, but not both of them at the same time.

:::

#### Flow Identifiers

- **target** (multiple choice: IP address/netmask or interface): **Target** is to be viewed from the perspective of the target. If you want to limit your users' upload capability, set "target upload".

Each of these two properties can be used to determine which direction is target upload and which is download. Be careful to configure both of these options for the same queue - in case they point to opposite directions, the queue will not work. If neither value of **target** nor of **interface** is specified, the queue will not be able to make the difference between upload and download and will limit all traffic twice.

#### Other properties

- **name** (Text) : Unique queue identifier that can be used as **parent** option value for other queues.
- **direction** (*both* | *upload* | *download*) : Specifies which direction to limit:
  - *both* - Limit both download and upload traffic.
  - *upload* - Limit only traffic to the target.
  - *download* - Limit only traffic from the target.
- **time** (*TIME-TIME,sun,mon,tue,wed,thu,fri,sat* - *TIME* is local time, all day names are optional; default: not set) : Allows you to specify time when particular queue will be active. The router must have correct time settings.
- **dst-address** (IP address/netmask) : Allows you to select only specific stream (from target address to this destination address) for limitation explain what is target and what is dst and what is upload and what not.
- **packet-marks** (Comma separated list of packet mark names) : Allows to use marked packets from `/ip/firewall/mangle`. Take a look at the RouterOS [packet flow diagram](../packet-flow-in-routeros.md). It is necessary to mark packets before the simple queues (before *global-in* HTB queue) or else target's download limitation will not work. The only mangle chain before *global-in* is *prerouting*.

#### HTB Properties

- **parent** (Name of parent simple queue, or *none*) : assigns this queue as a child queue for selected target. Target queue can be HTB queue or any other previously created simple queue. In order for traffic to reach child queues, parent queues must capture all necessary traffic.
- **priority** (1..8) : Prioritize one child queue over another child queue. Does not work on parent queues (if queue has at least one child). One is the highest, eight is the lowest priority. Child queue with higher priority will have a chance to reach its **max-limit** before child with lower priority. Priority has nothing to do with bursts.
- **queue** (*SOMETHING/SOMETHING*) : Choose the type of the upload/download queue. Queue types can be created in [`/queue/type`](#queue-types).
- **limit-at** (*NUMBER/NUMBER*) : Normal upload/download data rate that is guaranteed to a target.
- **max-limit** (*NUMBER/NUMBER*) : Maximal upload/download data rate that is allowed for a target to reach.
- **burst-limit** (*NUMBER/NUMBER*) : Maximal upload/download data rate which can be reached while the burst is active.
- **burst-time** (*TIME/TIME*) : Period of time, in seconds, over which the average upload/download data rate is calculated. (This is NOT the time of actual burst).
- **burst-threshold** (*NUMBER/NUMBER*) : When average data rate is below this value - burst is allowed, as soon as average data rate reaches this value - burst is denied. (basically this is a burst on/off switch). For optimal burst behavior this value should be above **limit-at** value and below **max-limit** value.

And corresponding options for *global-total* HTB queue:

- **total-queue** (*SOMETHING/SOMETHING*): corresponds to **queue**.
- **total-limit-at** (*NUMBER/NUMBER*): corresponds to **limit-at**.
- **total-max-limit** (*NUMBER/NUMBER*): corresponds to **max-limit**.
- **total-burst-limit** (*NUMBER/NUMBER*): corresponds to **burst-limit**.
- **total-burst-time** (*TIME/TIME*): corresponds to **burst-time**.
- **total-burst-threshold** (*NUMBER/NUMBER*): corresponds to **burst-threshold**.

Good practice suggests that:

Sum of children's limit-at values must be less than or equal to max-limit of the parent. Every child's max-limit must be less than max-limit of the parent. This way you will leave some traffic for the other child queues, and they will be able to get traffic without fighting for it with other child queues.

#### Statistics

- **rate** (read-only/read-only) : Average queue passing data rate in bytes per second.
- **packet-rate** (read-only/read-only) : Average queue passing data rate in packets per second.
- **bytes** (read-only/read-only) : Number of bytes processed by this queue.
- **packets** (read-only/read-only) : Number of packets processed by this queue.
- **queued-bytes** (read-only/read-only) : Number of bytes waiting in the queue.
- **queued-packets** (read-only/read-only) : Number of packets waiting in the queue.
- **dropped** (read-only/read-only) : Number of dropped packets.
- **borrows** (read-only/read-only) : Packets that passed queue over its "limit-at" value (and were unused and taken away from other queues).
- **lends** (read-only/read-only) : Packets that passed queue below its "limit-at" value OR if queue is a parent - sum of all child borrowed packets.
- **pcq-queues** (read-only/read-only) : Number of PCQ substreams, if queue type is PCQ.

And corresponding options for *global-total* HTB queue:

- **total-rate** (read-only): corresponds to *rate*.
- **total-packet-rate** (read-only): corresponds to *packet-rate*.
- **total-bytes** (read-only): corresponds to *bytes*.
- **total-packets** (read-only): corresponds to *packets*.
- **total-queued-bytes** (read-only): corresponds to *queued-bytes*.
- **total-queued-packets** (read-only): corresponds to *queued-packets*.
- **total-dropped** (read-only): corresponds to *dropped*.
- **total-lends** (read-only): corresponds to *lends*.
- **total-borrows** (read-only): corresponds to *borrows*.
- **total-pcq-queues** (read-only): corresponds to *pcq-queues*.

### Configuration example

In the following example, we have one SOHO device with two connected units PC and Server.

![](./img/simple-queue-soho-example.jpg)

We have a 15 Mbps connection available from an ISP in this case. We want to be sure the server receives enough traffic, so we will configure a simple queue with a *limit-at* parameter to guarantee the server receives 5Mbps:

```ros
/queue/simple
add limit-at=5M/5M max-limit=15M/15M name=queue1 target=192.168.88.251/32
```

That is all. The server will get 5 Mbps of traffic rate regardless of other traffic flows. If you are using the default configuration, be sure the FastTrack rule is disabled for this particular traffic, otherwise, it will bypass Simple Queues and they will not work.

## Queue Tree

**Sub-menu:** `/queue/tree`

The queue tree creates only a one-directional queue in one of the HTBs. It is also the only way to add a queue on a separate interface. This way it is possible to ease mangle configuration - you don't need separate marks for download and upload - only the upload will get to the Public interface and only the download will get to a Private interface. The main difference from Simple Queues is that the Queue tree is not ordered - all traffic passes it together.

### Configuration example

In the following example, we will mark all the packets coming from preconfigured *in-interface-list=LAN* and will limit the traffic with a queue tree based on these packet marks.

Let's create a firewall address-list:

```ros
[admin@MikroTik] > /ip/firewall/address-list
add address=www.youtube.com list=Youtube
[admin@MikroTik] > ip firewall address-list print
Flags: X - disabled, D - dynamic 
 #   LIST                                                       ADDRESS                                                                        CREATION-TIME        TIMEOUT             
 0   Youtube                                                    www.youtube.com                                                                2019-10-17 14:47:11
 1 D ;;; www.youtube.com
     Youtube                                                    216.58.211.14                                                                  2019-10-17 14:47:11
 2 D ;;; www.youtube.com
     Youtube                                                    216.58.207.238                                                                 2019-10-17 14:47:11
 3 D ;;; www.youtube.com
     Youtube                                                    216.58.207.206                                                                 2019-10-17 14:47:11
 4 D ;;; www.youtube.com
     Youtube                                                    172.217.21.174                                                                 2019-10-17 14:47:11
 5 D ;;; www.youtube.com
     Youtube                                                    216.58.211.142                                                                 2019-10-17 14:47:11
 6 D ;;; www.youtube.com
     Youtube                                                    172.217.22.174                                                                 2019-10-17 14:47:21
 7 D ;;; www.youtube.com
     Youtube                                                    172.217.21.142                                                                 2019-10-17 14:52:21

```

Mark packets with firewall mangle facility:

```ros
[admin@MikroTik] > /ip/firewall/mangle
add action=mark-packet chain=forward dst-address-list=Youtube in-interface-list=LAN new-packet-mark=pmark-Youtube passthrough=yes
```

Configure the queue tree based on previously marked packets:

```ros
[admin@MikroTik] /queue/tree
add max-limit=5M name=Limiting-Youtube packet-mark=pmark-Youtube parent=global
```

Check Queue tree stats to be sure traffic is matched:

```ros
[admin@MikroTik] > queue tree print stats
Flags: X - disabled, I - invalid 
 0   name="Limiting-Youtube" parent=global packet-mark=pmark-Youtube rate=0 packet-rate=0 queued-bytes=0 queued-packets=0 bytes=67887 packets=355 dropped=0 
```

## Queue Types

**Sub-menu:** `/queue/type`

This sub-menu lists by default created queue types and allows the addition of new user-specific ones.

By default, RouterOS creates the following pre-defined queue types:

```ros
[admin@MikroTik] > /queue/type/print
Flags: * - default 
 0 * name="default" kind=pfifo pfifo-limit=50 

 1 * name="ethernet-default" kind=pfifo pfifo-limit=50 

 2 * name="wireless-default" kind=sfq sfq-perturb=5 sfq-allot=1514 

 3 * name="synchronous-default" kind=red red-limit=60 red-min-threshold=10 red-max-threshold=50 red-burst=20 red-avg-packet=1000 

 4 * name="hotspot-default" kind=sfq sfq-perturb=5 sfq-allot=1514 

 5 * name="pcq-upload-default" kind=pcq pcq-rate=0 pcq-limit=50KiB pcq-classifier=src-address pcq-total-limit=2000KiB pcq-burst-rate=0 pcq-burst-threshold=0 pcq-burst-time=10s pcq-src-address-mask=32 
     pcq-dst-address-mask=32 pcq-src-address6-mask=128 pcq-dst-address6-mask=128 

 6 * name="pcq-download-default" kind=pcq pcq-rate=0 pcq-limit=50KiB pcq-classifier=dst-address pcq-total-limit=2000KiB pcq-burst-rate=0 pcq-burst-threshold=0 pcq-burst-time=10s pcq-src-address-mask=32 
     pcq-dst-address-mask=32 pcq-src-address6-mask=128 pcq-dst-address6-mask=128 

 7 * name="only-hardware-queue" kind=none 

 8 * name="multi-queue-ethernet-default" kind=mq-pfifo mq-pfifo-limit=50 

 9 * name="default-small" kind=pfifo pfifo-limit=10
```

All MikroTik products have the default queue type "**only-hardware-queue"** with "kind=none". "only-hardware-queue" leaves the interface with only a hardware transmit descriptor ring buffer which acts as a queue in itself. Usually, at least 100 packets can be queued for transmit in the transmit descriptor ring buffer. Transmit descriptor ring buffer size and the number of packets that can be queued in it vary for different types of ethernet MACs. Having no software queue is especially beneficial on SMP systems because it removes the requirement to synchronize access to it from different CPUs/cores which is resource-intensive. Having the possibility to set "only-hardware-queue" requires support in an ethernet driver so it is available only for some ethernet interfaces mostly found on RouterBOARDs.

A **"multi-queue-ethernet-default"** can be beneficial on SMP systems with ethernet interfaces that have support for multiple transmit queues and have Linux driver support for multiple transmit queues. By having one software queue for each hardware queue there might be less time spent on synchronizing access to them.

:::warning
The improvement from only-hardware-queue and multi-queue-ethernet-default is present only when there is no `/queue/tree` entry with a particular interface as a parent.

:::

### Kinds

Queue kinds are packet processing algorithms. Kind describes which packet will be transmitted next in the line. RouterOS supports the following Queueing kinds:

- FIFO (BFIFO, PFIFO, MQ PFIFO)
- RED
- SFQ
- PCQ

#### FIFO

These kinds are based on the FIFO algorithm (First-In-First-Out). The difference between **PFIFO** and **BFIFO** is that one is measured in packets and the other one in bytes. These queues use **pfifo-limit** and **bfifo-limit** parameters.

Every packet that cannot be enqueued (if the queue is full) is dropped. Large queue sizes can increase latency but utilize the channel better.

**MQ-PFIFO** is *pfifo* with support for multiple transmit queues. This queue is beneficial on SMP systems with ethernet interfaces that have support for multiple transmit queues and have Linux driver support for multiple transmit queues (mostly on x86 platforms). This kind uses the **mq-pfifo-limit** parameter.

#### RED

Random Early Drop is a queuing mechanism that tries to avoid network congestion by controlling the average queue size. The average queue size is compared to two thresholds: a minimum (min<sub>th</sub>) and a maximum (max<sub>th</sub>) threshold. If the average queue size (avg<sub>q</sub>) is less than the minimum threshold, no packets are dropped. When the average queue size is greater than the maximum threshold, all incoming packets are dropped. But if the average queue size is between the minimum and maximum thresholds, packets are randomly dropped with probability P<sub>d</sub>, where probability is exactly a function of the average queue size: P<sub>d</sub> = P<sub>max</sub>(avg<sub>q</sub> – min<sub>th</sub>)/ (max<sub>th</sub> - min<sub>th</sub>). If the average queue grows, the probability of dropping incoming packets grows too. P<sub>max</sub> is a ratio, which can adjust the packet discarding probability abruptness, (the simplest case P<sub>max</sub> can be equal to one). The 8.2 diagram shows the packet drop probability in the RED algorithm.

![](./img/queues-02.webp)

#### SFQ

Stochastic Fairness Queuing (SFQ) is ensured by hashing and round-robin algorithms. SFQ is called "Stochastic" because it does not really allocate a queue for each flow; it has an algorithm that divides traffic over a limited number of queues (1024) using a hashing algorithm.

Traffic flow may be uniquely identified by 4 options (*src-address, dst-address, src-port,* and *dst-port*), so these parameters are used by the SFQ hashing algorithm to classify packets into one of 1024 possible sub-streams. Then the round-robin algorithm will start to distribute available bandwidth to all sub-streams, on each round giving **sfq-allot** bytes of traffic. The whole SFQ queue can contain 128 packets and there are 1024 sub-streams available. The 8.3 diagram shows the SFQ operation:

![](./img/queues-03.webp)

#### PCQ

The PCQ algorithm is very simple - at first, it uses selected classifiers to distinguish one sub-stream from another, then applies individual FIFO queue size and limitation on every sub-stream, then groups all sub-streams together and applies global queue size and limitation.

PCQ parameters:

- **pcq-classifier** (dst-address | dst-port | src-address | src-port; default: "") : Selection of sub-stream identifiers.
- **pcq-rate** (number): Maximal available data rate of each sub-stream.
- **pcq-limit** (number): Queue size of a single sub-stream (in KiB).
- **pcq-total-limit** (number): Maximum amount of queued data in all sub-streams (in KiB).

 It is possible to assign a speed limitation to sub-streams with the **pcq-rate** option. If "pcq-rate=0", sub-streams will divide available traffic equally.

![](./img/queues-04.webp)

For example, instead of having 100 queues with 1000kbps limitation for download, we can have one PCQ queue with 100 sub-streams.

PCQ has a burst implementation identical to Simple Queues and Queue Tree:

- **pcq-burst-rate** (number): Maximal upload/download data rate which can be reached while the burst for substream is allowed.
- **pcq-burst-threshold** (number): This is the value of the burst on/off switch.
- **pcq-burst-time** (time): A period of time (in seconds) over which the average data rate is calculated. (This is NOT the time of the actual burst).

PCQ also allows using different-sized IPv4 and IPv6 networks as sub-stream identifiers. Before it was locked to a single IP address. This is done mainly for IPv6 as customers from an ISP point of view will be represented by a /64 network, but devices in the customer's network will be /128. PCQ can be used for both of these scenarios and more. PCQ parameters:

- **pcq-dst-address-mask** (number): the size of the IPv4 network that will be used as a dst-address sub-stream identifier.
- **pcq-src-address-mask** (number): the size of the IPv4 network that will be used as an src-address sub-stream identifier.
- **pcq-dst-address6-mask** (number): the size of the IPv6 network that will be used as a dst-address sub-stream identifier.
- **pcq-src-address6-mask** (number): the size of the IPv6 network that will be used as an src-address sub-stream identifier.

:::info
The following queue kinds CoDel, FQ-Codel, and CAKE available since RouterOS version 7.1beta3.

:::

#### CoDel

CoDel (Controlled-Delay Active Queue Management) algorithm uses the local minimum queue as a measure of the persistent queue; similarly, it uses a minimum delay parameter as a measure of the standing queue delay. Queue size is calculated using packet residence time in the queue.

**Properties**

| **Property** | **Description** |
| :-- | :-- |
| **codel-ce-threshold** (*default*: ) | Marks packets above a configured threshold with ECN. |
| **codel-ecn** (*default*: **no**) | An option is used to mark packets instead of dropping them. |
| **codel-interval** (*default*: **100ms**) | Interval should be set on the order of the worst-case RTT through the bottleneck, giving endpoints sufficient time to react. |
| **codel-limit** (*default*: **1000**) | Queue limit. When the limit is reached, incoming packets are dropped. |
| **codel-target** (*default*: **5ms**) | Represents an acceptable minimum persistent queue delay. |

#### FQ-Codel

CoDel - Fair Queuing (FQ) with Controlled Delay (CoDel) uses a randomly determined model to classify incoming packets into different flows and is used to provide a fair share of the bandwidth to all the flows using the queue. Each flow is managed using the CoDel queuing discipline which internally uses a FIFO algorithm.

**Properties**

| **Property** | **Description** |
| :-- | :-- |
| **fq-codel-ce-threshold** (*default*: ) | Marks packets above a configured threshold with ECN. |
| **fq-codel-ecn** (*default*: **yes**) | An option is used to mark packets instead of dropping them. |
| **fq-codel-flows** (default: **1024**) | The number of flows into which the incoming packets are classified. |
| **fq-codel-interval** (*default*: **100ms**) | Interval should be set on the order of the worst-case RTT through the bottleneck giving endpoints sufficient time to react. |
| **fq-codel-limit** (*default*: **10240**) | Queue limit. When the limit is reached, incoming packets are dropped. |
| **fq-codel-memlimit** (default: **32.0MiB**) | The total number of bytes that can be queued in this FQ-CoDel instance. Will be enforced from the *fq-codel-limit* parameter. |
| **fq-codel-quantum** (*default*: **1514**) | The number of bytes used as 'deficit' in the fair queuing algorithm. Default (1514 bytes) corresponds to the Ethernet MTU plus the hardware header length of 14 bytes. |
| **fq-codel-target** (*default*: **5ms**) | Represents an acceptable minimum persistent queue delay. |

#### CAKE

CAKE - Common Applications Kept Enhanced (CAKE), implemented as a *queue discipline* (qdisc) for the Linux kernel, uses COBALT (AQM algorithm combining Codel and BLUE) and a variant of DRR++ for flow isolation. In other words, Cake’s fundamental design goal is user-friendliness. All settings are optional; the default settings are chosen to be practical in most common deployments. In most cases, the configuration requires only a bandwidth parameter to get useful results.

**Properties**

| **Property** | **Description** |
| :-- | :-- |
| **cake-ack-filter** *(default:* **none** ) |  |
| **cake-atm** *(default:* ) | Compensates for ATM cell framing, which is normally found on ADSL links. |
| **cake-autorate-ingress** *(yes/no, default:* ) | Automatic capacity estimation based on traffic arriving at this qdisc. This is most likely to be useful with cellular links, which tend to change quality randomly.  The Bandwidth Limit parameter can be used in conjunction with it to specify an initial estimate. The shaper will periodically be set to a bandwidth slightly below the estimated rate.  This estimator cannot estimate the bandwidth of links downstream of itself. |
| **cake-bandwidth** *(default:* ) | Sets the shaper bandwidth. |
| **cake-diffserv** *(default:* **diffserv3**) | CAKE can divide traffic into "tins" based on the Diffserv field: diffserv4 Provides a general-purpose Diffserv implementation with four tins: Bulk (CS1), 6.25% threshold, generally low priority. Best Effort (general), 100% threshold. Video (AF4x, AF3x, CS3, AF2x, CS2, TOS4, TOS1), 50% threshold. Voice (CS7, CS6, EF, VA, CS5, CS4), 25% threshold.diffserv3 (default) Provides a simple, general-purpose Diffserv implementation with three tins: Bulk (CS1), 6.25% threshold, generally low priority. Best Effort (general), 100% threshold. Voice (CS7, CS6, EF, VA, TOS4), 25% threshold, reduced Codel interval. |
| **cake-flowmode** *(dsthost/dual-dsthost/dual-srchost/flowblind/flows/hosts/srchost/triple-isolate, default:* **triple-isolate**) | flowblind - Disables flow isolation; all traffic passes through a single queue for each tin.srchost - Flows are defined only by source address. dsthost Flows are defined only by destination address. hosts - Flows are defined by source-destination host pairs. This is host isolation, rather than flow isolation.flows - Flows are defined by the entire 5-tuple of source address, a destination address, transport protocol, source port, and destination port. This is the type of flow isolation performed by SFQ and fq_codel.dual-srchost Flows are defined by the 5-tuple, and fairness is applied first over source addresses, then over individual flows. Good for use on egress traffic from a LAN to the internet, where it'll prevent any LAN host from monopolizing the uplink, regardless of the number of flows they use.dual-dsthost Flows are defined by the 5-tuple, and fairness is applied first over destination addresses, then over individual flows. Good for use on ingress traffic to a LAN from the internet, where it'll prevent any LAN host from monopolizing the downlink, regardless of the number of flows they use.triple-isolate - Flows are defined by the 5-tuple, and fairness is applied over source *and* destination addresses intelligently (ie. not merely by host-pairs), and also over individual flows.nat Instructs Cake to perform a NAT lookup before applying flow-isolation rules, to determine the true addresses and port numbers of the packet, to improve fairness between hosts "inside" the NAT. This has no practical effect in "flowblind" or "flows" modes, or if NAT is performed on a different host.nonat (default) Cake will not perform a NAT lookup. Flow isolation will be performed using the addresses and port numbers directly visible to the interface Cake is attached to. |
| **cake-memlimit** *(default:* ) | Limit the memory consumed by Cake to LIMIT bytes. By default, the limit is calculated based on the bandwidth and RTT settings. |
| **cake-mpu** *( -64 ... 256, default:* ) | Rounds each packet (including overhead) up to a minimum length BYTES. |
| **cake-nat** *(default:* **no)** | Instructs Cake to perform a NAT lookup before applying a flow-isolation rule. |
| **cake-overhead** *( -64 ... 256, default:* ) | Adds BYTES to the size of each packet. BYTES may be negative. |
| **cake-overhead-scheme** *(default:* ) |  |
| **cake-rtt** *(default:* **100ms** ) | Manually specify an RTT. The default 100ms is suitable for most Internet traffic. |
| **cake-rtt-scheme** *(datacentre/internet/interplanetary/lan/metro/none/oceanic/regional/satellite, default:* ) | datacentre - For extremely high-performance 10GigE+ networks only. Equivalent to RTT 100us.lan - For pure Ethernet (not Wi-Fi) networks, at home or in the office. Don't use this when shaping for an Internet access link. Equivalent to RTT 1ms.metro - For traffic mostly within a single city. Equivalent to RTT 10ms. regional For traffic mostly within a European-sized country. Equivalent to RTT 30ms.internet (default) This is suitable for most Internet traffic. Equivalent to RTT 100ms.oceanic - For Internet traffic with generally above-average latency, such as that suffered by Australasian residents. Equivalent to RTT 300ms.satellite - For traffic via geostationary satellites. Equivalent to RTT 1000ms.interplanetary - So named because Jupiter is about 1 light-hour from Earth. Use this to (almost) completely disable AQM actions. Equivalent to RTT 3600s. |
| **cake-wash** *(default:* **no** ) | Apply the wash option to clear all extra DiffServ (but not ECN bits), after priority queuing has taken place. |

## Interface Queue

**Sub-menu:** `/queue/interface`

Before sending data over an interface, it is processed by the queue. This sub-menu lists all available interfaces in RouterOS and allows changing queue type for a particular interface. The list is generated automatically.

```ros
[admin@MikroTik] > /queue/interface/print
Columns: INTERFACE, QUEUE, ACTIVE-QUEUE
# INTERFACE QUEUE ACTIVE-QUEUE
0 ether1 only-hardware-queue only-hardware-queue
1 ether2 only-hardware-queue only-hardware-queue
2 ether3 only-hardware-queue only-hardware-queue
3 ether4 only-hardware-queue only-hardware-queue
4 ether5 only-hardware-queue only-hardware-queue
5 ether6 only-hardware-queue only-hardware-queue
6 ether7 only-hardware-queue only-hardware-queue
7 ether8 only-hardware-queue only-hardware-queue
8 ether9 only-hardware-queue only-hardware-queue
9 ether10 only-hardware-queue only-hardware-queue
10 sfp-sfpplus1 only-hardware-queue only-hardware-queue
11 wlan1 wireless-default wireless-default
12 wlan2 wireless-default wireless-default 
```

## Queue load visualization in GUI

In Winbox and Webfig, a green, yellow, or red icon visualizes each Simple and Tree queue usage based on max-limit.

|  |  |
| :-- | :-- |
| ![](./img/queue-usage-0-50.png)  | 0% - 50% of max-limit used |
| ![](./img/queue-usage-50-75.png)  | >50% - 75% of max-limit used |
| ![](./img/queue-usage-75-100.png)  | >75% - 100% of max-limit used |
