# Apps

> The Apps menu provides a catalog of pre-configured applications deployable via containers, with automatic RouterOS configuration and support for multiple container registries. It requires Container package installation, physical access for initial setup, and includes security considerations such as certificate verification and hardware device management.

# Apps

#### Summary

**Sub-menu:** `/app`  
**Packages required:** `container`

The App menu provides a catalog of applications that can be deployed in a couple of clicks. Each app can consist of one or multiple pre-configured containers and the necessary RouterOS configuration such as firewall rules and address translation will be applied automatically. This catalog is prepared and maintained by MikroTik, but the container images get sourced from multiple registries such as Docker Hub, GCR and Quay.

The configuration parameters, however, can be edited before enabling an app, and the applied yaml file can always be viewed.

#### Requirements

The App system inherits the same requirements as the Container package:

- **Architecture Support:** arm64 and x86 architectures.
- **Container Package:** Must be installed.
- **Device Mode:** Container mode must be enabled (requires physical access and device reset).
- **External Storage:** Highly recommended for optimal performance.
- **Memory Requirements:** Adequate RAM for container operations (16MB SPI flash devices may require external storage for images).
- **Architecture Limitations:** Devices with EN7562CT CPU (like hEX Refresh) are not supported.

#### Security Considerations

As with the underlying Container system, the App menu inherits security implications:

- Physical access is required to initially enable container support.
- Once enabled, containers can be managed remotely.
- Compromised devices can use containers to install malicious software.
- Device security is equivalent to the security of running containers.
- Third-party container images may introduce security vulnerabilities.

## Properties

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| **auto-update** | *yes* &#124; *no* | *no* | Enables or disables automatic updating when a new container image version is available. |
| **check-certificate** | *yes* &#124; *no* | *yes* | Verifies the registry certificate before pulling the container image. |
| **container-command-lines** | *string* | *(empty)* | Specifies the command-line argument(s) to pass to the application when starting the container. |
| **devices** | *string* | *(empty)* | Specifies additional hardware devices to pass through to the container application. |
| **environment** | *string* | *(empty)* | Defines environment variables to be available to the running application. Specify as a list of key-value pair(s). |
| **extra-mounts** | *string* | *(empty)* | Specifies additional mount points to attach to the container. |
| **firewall-redirects** | *string* | *(empty)* | Configures port redirection from the host device to the container. |
| **network** | *default* &#124; *lan* &#124; *internal* | *default* | Specifies which network the container will use: **internal** (behind NAT), **lan** (on the LAN network), or **default** (varies per application; can be internal or lan). |
| **network-outgoing-access** | *yes* &#124; *no* | *yes* | Allows network outgoing access for the specific container app, when set to `no`, a mangle drop rule is created. |
| **pvid** | *integer* | *1* | Sets the Port VLAN ID (PVID) for the container's virtual Ethernet interface in the bridge. |
| **required-hw-devices** | *string* | *(empty)* | Hardware devices that must be present on the host for the container to start. This property is configurable only after adding the YAML configuration. **Compose format:**`[host-hw-device]:[device-in-app]` |
| **required-mounts** | *string* | *(empty)* | Mount directories required for the container to start. This property is configurable only after adding the YAML configuration. **Compose format:**`[dir-on-host]:[dir-in-app]` |
| **use-https** | *yes* &#124; *no* | *yes* | Uses HTTPS for the application URL. This option will not work on devices that do not support cloud services. |
| **yaml** | *string* | *(empty)* | Provides the YAML composition for the application. See the documentation for configuration examples. |

## Read-only Properties

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| **app-size** | | | The total size of the application. |
| **app-store-url** | *string* | | The URL of the app store from which the application was installed. |
| **cpu-usage** | | | The current CPU usage percentage by the application. |
| **custom** | *yes* &#124; *no* | | Indicates whether the application is a custom application created by the user. |
| **data-size** | | | The size of the data stored by the application. |
| **default-credential** | *string* | | The default credentials required for the application. |
| **default-network** | *lan* &#124; *internal* | | The default network used by the application. Valid values are `lan` or `internal`. |
| **description** | *string* | | The application description as defined in the `descr` parameter of the YAML configuration. |
| **from-app-store** | *yes* &#124; *no* | | Indicates whether the application was installed from a custom app store. |
| **interface** | *string* | | The VETH interface used by the application. |
| **ip-address** | *IP* | | The IP address assigned to the VETH interface. |
| **memory-current** | | | The amount of memory currently used by the application. |
| **name** | *string* | | The application name as defined in the `name` parameter of the YAML configuration. |
| **project-page** | *string* | | The application project page URL as defined in the `page` parameter of the YAML configuration. |
| **running** | | | Indicates whether the application is currently running. |
| **status** | *acquire veth* &#124; *configuring container(s)* &#124; *downloading/extracting* &#124; *starting* | | The current status of the application. Possible values indicate the application is acquiring a VETH interface, configuring containers, downloading/extracting, or starting. |
| **ui-url** | *string* | | The generated URL for the application's web interface, if available. |
| **variables-to-be-used-in-environment** | | | A list of all variables present in the application environment. |

#### Setup Wizard

The App menu includes a setup wizard (button "Setup" in the GUI, or command `/app/setup`). This wizard automates all the networking, storage, and registry setup that would otherwise require multiple manual steps.

##### Step 1: Storage Selection

Select a storage disk for application installation. The system automatically detects available formatted disks drives (such as nvme1, usb1, disk1, and similar devices). If no suitable disk appears in the list, you must first format the disk using either the ext4 or btrfs file system, then mount it through the `/disk` menu.

**Requirements:**

- A minimum of 100 MB/s sequential read/write speed is recommended.
- A minimum of 10,000 random IOPS (Input/Output Operations Per Second) is recommended.
- Use the `/disk/test` command to verify storage performance before proceeding.
- External storage devices are highly recommended for optimal performance.

##### Step 2: Bridge Configuration

Select the LAN bridge interface for container networking. This configuration enables automatic port forwarding and application autodiscovery on the local network. The setup wizard automatically configures the following:

- Virtual ethernet (veth) interface creation
- Addition of the veth interface to the configured bridge
- NAT rules for outbound connectivity

##### Step 3: IP Configuration

Define the router's IP address to enable application access. The system automatically detects the primary IP address; however, manual configuration is supported for complex network setups. The specified IP address serves the following purposes:

- Generating application UI URLs.
- Creating automatic port forwarding rules.
- Providing WebFig integration links.

##### Completion

Once you complete the setup wizard, the App system is ready for immediate use. You can enable applications directly through the interface. The system automatically handles all underlying container configuration.

#### Configuration

App configuration is accessible through `/app/settings` and provides a simplified setup compared to manual Container configuration

## Properties

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| **app-store-urls** | *string* | *(empty)* | URL to a custom app store. The URL must point to a YAML array where each application is an element within the array. |
| **auto-update** | *yes* &#124; *no* | *no* | Global setting that enables automatic updates for all installed applications packages. |
| **disk** | *string* | *(empty)* | Global setting that specifies which disk will be used for storage operations. |
| **download-path** | *string* | *(empty)* | Manually specifies the directory path where all downloaded content will be stored. |
| **lan-bridge** | *string* | *(empty)* | Manually specifies the bridge interface that represents the local area network. |
| **media-path** | *string* | *(empty)* | Manually specifies the directory path where all media files will be stored. |
| **registry-mirrors** | *string* | *(empty)* | Specifies one or more registry mirror URLs addresses for container image retrieval. |
| **router-ip** | *IP* | *(empty)* | Manually specifies the IP address at which the current RouterOS device can be reached. |
| **show-in-webfig** | *yes* &#124; *no* | *yes* | Controls whether links to enabled applications are displayed on the WebFig login page. |

### Auto-Configured Settings

Certain parameters are initially configured automatically based on network detection. These values can always be manually overridden if required.

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| **assumed-router-ip** | *IP* | *(detected)* | Automatically detected network IP address of the RouterOS device. |
| **assumed-lan-bridge** | *string* | *(detected)* | Automatically detected bridge interface used for LAN connectivity. |
| **assumed-media-path** | *string* | *disk/media* | Default media storage path, typically located on the system disk. |
| **assumed-download-path** | *string* | *disk/media/downloads* | Default download directory path, typically located within the media storage area. |

#### Application Management

Applications are managed through the `/app` interface, providing status monitoring and lifecycle control similar to the underlying `/container` system:

```
/app> print 
Flags: X - DISABLED, R - RUNNING
Columns: NAME, UI-URL, MEMORY-CURRENT, APP-SIZE, DATA-SIZE, CATEGORY, DESCRIPTION
```

##### Status Indicators and Metadata

- **Flags:**
  - X (DISABLED) - Can indicate two states: not downloaded/installed (APP-SIZE and DATA-SIZE will be empty), or downloaded but disabled (APP-SIZE and DATA-SIZE show storage usage).
  - R (RUNNING) - Application actively running and accessible.
- **UI-URL:** Direct web interface access URL when application is running.
- **MEMORY-CURRENT:** Real-time memory consumption in MiB (only when running).
- **APP-SIZE:** Container image storage consumption in MiB (shows space used when downloaded).
- **DATA-SIZE:** Application persistent data size in KiB/MiB (shows configuration and user data).
- **CATEGORY:** Application functional classification.
- **DESCRIPTION:** Application functionality description.

##### Application Lifecycle Management

### Deployment Process

Unlike manual Container deployment which requires multiple configuration steps (veth interface, bridge setup, environment variable, mount, and firewall rules), App deployment automates the entire process:

1. **Selection:** Choose an application from the catalog via CLI or WebFig.
2. **Download:** Automatic container image download and extraction.
3. **Network Setup:** Automatic veth interface and bridge configuration.
4. **Port Forwarding:** Automatic firewall rule creation for web access.
5. **Startup:** Container initialization with pre-configured settings.
6. **Access:** UI-URL becomes available for immediate web interface access.

#### Cleanup Command

The cleanup command provides complete application removal, including all associated data. This operation is destructive and irreversible:

```
/app> cleanup pihole 
App data will be lost, continue? [y/N]:
```

**Cleanup Process:**

1. Stops the running container.
2. Removes all application data and configuration files.
3. Deletes the container image from storage.
4. Resets the application to an uninstalled state (empty APP-SIZE and DATA-SIZE).
5. Removes network configuration specific to the application.

:::warning

All user data, configuration settings, and application state will be permanently lost. The application will return to its original catalog state and require complete reconfiguration if cleaned-up.

:::

#### User-Addable Apps

Starting with RouterOS v7.22, you can create your own custom apps using a compose YAML file. This lets experienced users build solutions that fit their specific network needs.

How it works:

- You write a compose YAML file that defines your app's structure and behavior
- RouterOS processes this file to build a working application package
- Your custom app can work with RouterOS features and APIs

Why use it:

- Build exactly what you need for your network
- No need to wait for official app releases
- Great for automation, custom routing, or specialized services
- Declarative setup makes management easier

## Creating a Custom App with YAML

You can create a custom container application using a YAML configuration file. This example demonstrates how to set up an Alpine Linux container that runs an iperf3 server for network performance testing.

### YAML Configuration Example

```routeros
name: alpine-iperf
descr: Alpine Linux container running iperf3 server
page: https://iperf.fr/
category: network
default-credential: none
services:
  iperf:
    image: docker.io/alpine:latest
    ports:
      - 5201:5201:tcp
      - 5201:5201:udp
    command: /bin/sh -c "apk add --no-cache iperf3 && iperf3 -s"
```

### Configuration Field Reference

| Field | Description |
|---|---|
| `name` | Unique identifier for your custom app |
| `descr` | Human-readable description of what the app does |
| `page` | URL to the project's official documentation or website |
| `category` | Classification group (e.g., network, system, utilities) |
| `default-credential` | Authentication requirement (none, or specify username/password) |
| `services` | Container service definitions |
| `image` | Docker image to use for the container |
| `ports` | Port mappings in format `host:container:protocol` |
| `command` | Startup command executed inside the container |

### How This Example Works

1. **Base Image**: Uses the official Alpine Linux image from Docker Hub
2. **Package Installation**: Installs iperf3 network performance testing tool
3. **Server Mode**: Runs iperf3 in server mode (`-s` flag) to accept client connections
4. **Port Exposure**: Maps TCP and UDP port 5201 (iperf3's default port) to the host

This configuration creates a container that acts as a network throughput testing server, allowing you to measure bandwidth between clients and this container.

## Adding a Custom App

There are two ways to create a custom app: by importing a .yml file or by creating a blank app and editing its YAML directly.

In this example, we'll add the alpine-iperf app we created using the compose file. For ease of use, we'll place it in the LAN bridge so that devices on our network can access it easily without requiring NAT.

### Method 1: Create a Blank App and Edit YAML

First, create the app and assign it to the LAN network:

```routeros
/app/add network=lan
```

By default, the app will be named "app".

Next, add the YAML configuration. In the Terminal, run:

```routeros
/app/edit app yaml
```

This opens a text editor where you can paste your YAML. After pasting, press <kbd>Control</kbd>+<kbd>O</kbd> to save your changes. Finally, enable the app to start it running.

### Method 2: Import from a File

Alternatively, save your compose text to a file and upload it to the device. Then, set the file as the app's YAML using the following command:

```routeros
/app/add yaml=[/file/get alpine-iperf.yml contents]
```

This method is useful when you have a pre-configured YAML file ready to import.

#### Tips and Best Practices

- **Storage:** For optimal performance and greater capacity, consider using external storage devices such as USB drive, SATA drive, or NVMe SSD.

- **Memory:** Keep track of your application's memory consumption by running the `/app/print` command in the terminal.

- **Updates:** Only update your system when required and deemed necessary. While automatic updates can provide security patches and new features, it's important to assess whether an update is needed for your specific use case before enabling or applying it.

- **Networking:** The application automatically manages port forwarding and generates the necessary URL for external access.

- **Data Persistence:** Your application data is stored in the designated storage path and will remain intact even after the application restarts or the system reboots.
