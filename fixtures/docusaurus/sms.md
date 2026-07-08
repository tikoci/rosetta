# SMS

> This page documents SMS functionality in MikroTik RouterOS, enabling GSM modem communication for sending and receiving SMS messages via AT commands. It covers sending methods, parameters like port, phone number, message encoding, and USSD messaging support for network provider interactions.

# SMS

## Summary

It is possible to connect the GSM modem to the RouterOS device and use it to send and receive SMS messages. RouterOS lists such a modem as a serial port that appears in the `/port/print` listing. The GSM standard defines AT commands for sending SMS messages and defines how messages should be encoded in these commands. `'/tool/sms/send'` uses standard GSM AT commands to send SMS.

## Sending

**Sub-menu:** `/tool/sms/send`

### **Example**

Sending a command for the ppp interface:

```ros
/tool/sms/send usb3 "20000000" \ message="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#\$%^&*(){}[]\"'~"
```

For the LTE interface use the LTE interface name in the port field:

```ros
/tool/sms/send lte1 "20000000" \ message="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#\$%^&*(){}[]\"'~"
```

| Parameter | Description |
| :-- | :-- |
| **port** (*string*) | Name of port from `/port` that GSM modem is attached to. |
| **phone-number** (*string*) | Recipient phone number. Allowed characters are "0123456789\*#abc". If the first character is "+" then the phone number type is set to *international*, otherwise, it is set to *unknown*. |
| **channel** (*integer*) | Which modem channel to use for sending. |
| **message** (*string*) | Message contents. It is encoded using GSM 7 encoding (UCS2 currently is not supported), so the message length is limited to 160 characters. Characters `^{}\\[]~` are extended GSM 7-bit characters that each consume two character slots, reducing the effective limit below 160 when present. |
| **smsc** (*string*) |  |
| **type** (*string*) | If set to *class-0*, then send a class 0 SMS message. It is displayed immediately and not stored in the phone. |
| **sms-storage** (*string*) | Select the storage where to save received SMS (modem/sim) |
| **status-report-request** (*yes \| no*; Default: yes) | Set "no" to not request a confirmation message indicating whether a text message was successfully sent to the recipient. |

## USSD messages

USSD (Unstructured Supplementary Service Data) messages can be used to communicate with a mobile network provider to receive additional information, enabling additional services or adding funds to prepaid cards. USSD messages can be processed by using AT commands (commands can differ or even may be blocked on some modems).

**3G or GSM network modes must be activated to use this functionality**, as it's not supported under LTE only mode (**R11e-LTE** modem auto switches to 3G mode to send out USSD messages).

PDU (Protocol Data Unit) message and its decrypted version are printed under LTE debug logging.

### **Example**

Check if LTE debug logging is active:

```ros
/system/logging/print
Flags: X - disabled, I - invalid, * - default 
# TOPICS ACTION PREFIX 
0 * info memory 
1 * error memory 
2 * warning memory 
3 * critical echo 
```

If there is no logging entry, add it by running this command:

```ros
/system/logging/add topics=lte,!raw

/system/logging/print
Flags: X - disabled, I - invalid, * - default 
# TOPICS ACTION PREFIX 
0 * info memory 
1 * error memory 
2 * warning memory 
3 * critical echo 
4 lte,!raw memory 
```

To receive account status from **\*245#**

```ros
/interface/lte/at-chat lte1 input="AT+CUSD=1,\"*245#\",15"
output: OK
/log/print
11:51:20 lte,async lte1: sent AT+CUSD=1,"*245#",15 
11:51:20 lte,async lte1: rcvd OK 
11:51:23 lte,async,event +CUSD: 0,"EBB79B1E0685E9ECF4BADE9E03", 0 
11:51:23 gsm,info USSD: konta atlikums
```

## Receiving

RouterOS also supports receiving SMS messages, can execute scripts, and even responds to the sender.

Before the router can receive SMS, the relevant configuration is required in the `/tool/sms` menu. The following parameters are configurable:

| Parameter | Description |
| :-- | :-- |
| **allowed-number** (*string*; Default: "") | The sender number that will be allowed to run commands must specify the country code i.e. +371XXXXXXX |
| **channel** (*integer*; Default: **0**) | Which modem channel to use for receiving. |
| **keep-max-sms** (*integer*; Default: **0**) | Maximum number of messages that will be saved. If you set this bigger than the SIM supports, new messages will not be received. Replaced with the `auto-erase` parameter starting from RouterOS v6.44.6 |
| **auto-erase** (*yes \| no*; Default: **no**) | SIM storage size is read automatically. When `auto-erase=no` new SMS will not be received if storage is full. Set `auto-erase=yes` to delete the oldest received SMS to free space for new ones automatically. Available starting from v6.44.6 |
| **port** (*string*; Default: (**unknown**)) | Modem port (modem can be used only by one process "/port> print") |
| **receive-enabled** (*yes \| no*; Default: **no**) | Must be turned on to receive messages |
| **secret** (*string*; Default: "") *[sensitive](../getting-started/configuration-management/list-of-menus-with-sensitive-parameters.md)* | The secret password, mandatory |
| **polling**(*yes \| no*; Default: **no**) | Checking the modem for new SMS every 10s, instead of updating the inbox only after receiving the command from the modem. Available starting from v7.16 |
| **sim-pin**(string; Default:) *[sensitive](../getting-started/configuration-management/list-of-menus-with-sensitive-parameters.md)* | SIM card's PIN code. |

### Basic Example configuration to be able to view received messages

```ros
/tool/sms/set receive-enabled=yes port=lte1

/tool/sms/print 
           status: running
  receive-enabled: yes
             port: lte1
          channel: 0
           secret: 
   allowed-number: 
       auto-erase: no
          sim-pin: 
        last-ussd: 
```

### **Inbox**

**Sub-menu:** `/tool/sms/inbox`

If you have enabled the reader, you will see incoming messages in this submenu:

Read-only properties:

| Property | Description |
| :-- | :-- |
| **phone** (*string*) | Sender's phone number. |
| **message** (*string*) | Message body |
| **timestamp** (*time*) | The time when the message was received. It is the time sent by the operator, not the router's local time. |
| **type** (*string*) | Message type |

### **Syntax**

```ros
 :cmd SECRET script NAME [[ VAR[=VAL] ] ... ]
```

- **SECRET** - the password
- **NAME** - the name of the script that's available in `/system/script`
- **VAR** - variables that will be passed to the script (can be passed as VAR or as VAR=value), separated by spaces.

Other things to remember:

- \*Parameters can be put into quotes "VAR"="VAL" if necessary.
- \*Escaping of values is not supported (VAR="\"").
- \*Combined SMS are not supported, every SMS will be treated separately.
- \* 16Bit unicode messages are not supported.
- \* SMS are decoded with the standard GSM7 alphabet, so you can't send in other encodings, otherwise they will be decoded incorrectly.

### **Examples**

#### Wrong

```ros
:cmd script mans_skripts
:cmd slepens script mans skripts
:cmd slepens script mans_skripts var=
:cmd slepens script mans_skripts var= a
:cmd slepens script mans_skripts var=a a
```

#### Right

```ros
:cmd slepens script mans_skripts
:cmd slepens script "mans skripts"
:cmd slepens script mans_skripts var
:cmd slepens script mans_skripts var=a
:cmd slepens script mans_skripts var="a a" 
```

## Debugging

`/tool/sms/send` command is logging data that is written and read. It is logged with tags *gsm,debug,write* and *gsm,debug,read*. For more information see `/system/logging`.

## Implementation details

*AT+CMGS* and *AT+CMGF* commands are used. The port is acquired for the duration of the command and cannot be used concurrently by another RouterOS component. The message sending process can take a long time. It times out after a minute and after two seconds during the initial AT command exchange.
