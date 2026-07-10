# Scheduler

> The MikroTik RouterOS scheduler enables timed execution of scripts, allowing precise control over when and how often tasks run. It supports interval-based or one-time execution, with properties like start time, interval duration, and script event names.

# Scheduler

### Summary

The scheduler can trigger script execution at a particular time moment, after a specified time interval, or both.

### Properties

- **interval** *(time; default: 0s)*  - Interval between two script executions, if the time interval is set to zero, the script is only executed at its start time, otherwise it is executed repeatedly at the time interval specified.
- **name** *name)*  - Name of the task.
- **on-event** *(name)*  - Name of the script to execute. It must be present at `/system/script`.
- **run-count** *(read-only: integer)*  - To monitor script usage, this counter is incremented each time the script is executed.
- **start-date** *(date)*  - Date of the first script execution.
- **start-time** *(time)*  - Time of the first script execution.
- **startup**  - Execute the script 3 seconds after the system startup.

### Notes

Rebooting the router will reset the run-count counter.

If more than one script has to be executed simultaneously, they are executed in the order they appear in the scheduler configuration. This can be important if one scheduled script is used to disable another one.

If a more complex execution pattern is needed, it can usually be done by scheduling several scripts, and making them enable and disable each other.

**Note:** if a scheduler item has start-time set to startup, it behaves as if start-time and start-date were set to a time 3 seconds after console starts up. It means that all scripts having `start-time is startup` and `interval is 0` will be executed once each time router boots. If the interval is set to a value other than 0, the scheduler will **not** run at startup

### Examples

We will add a task that executes the script log-test every hour:

```ros
[admin@MikroTik] /system/script> add name=log-test source=":log info message=test" 
[admin@MikroTik] /system/script> print 
Flags: I - invalid 
0 name="log-test" owner="admin" policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon dont-require-permissions=no run-count=0 
source=:log info message=test 
[admin@MikroTik] /system/script> .. /scheduler 
[admin@MikroTik] /system/scheduler> add name=run-1h interval=1h 
on-event=log-test 
[admin@MikroTik] /system/scheduler> print 
Flags: X - disabled 
# NAME ON-EVENT START-DATE START-TIME INTERVAL RUN-COUNT 
0 run-1h log-test 2004-03-30 06:11:35 1h 0 
[admin@MikroTik] /system/scheduler>
```

In another example, there will be two scripts added that will change the bandwidth setting of a queue rule "Cust0". Every day at 9AM the queue will be set to 64Kb/s and at 5PM the queue will be set to 128Kb/s. The queue rule, the scripts, and the scheduler tasks are below:

```ros
[admin@MikroTik] /queue/simple> add name=Cust0 interface=ether1 \ 
\... dst-address=192.168.0.0/24 limit-at=64000
 [admin@MikroTik] /queue/simple> print
 Flags: X - disabled, I - invalid 0 name="Cust0" target-address=0.0.0.0/0 dst-address=192.168.0.0/24
 interface=ether1 limit-at=64000 queue=default priority=8 bounded=yes 
[admin@MikroTik] /queue/simple> /system/script 
[admin@MikroTik] /system/script> add name=start_limit source={/queue/simple/set \
 \... Cust0 limit-at=64000} 
[admin@MikroTik] /system/script> add name=stop_limit source={/queue/simple/set \ 
\... Cust0 limit-at=128000} 
[admin@MikroTik] /system/script> print 
0 name="start_limit" source="/queue/simple/set Cust0 limit-at=64000" 
owner=admin run-count=0 
1 name="stop_limit" source="/queue/simple/set Cust0 limit-at=128000" 
owner=admin run-count=0 
[admin@MikroTik] /system/script> .. scheduler 
[admin@MikroTik] /system/scheduler> add interval=24h name="set-64k" \ 
\... start-time=9:00:00 on-event=start_limit 
[admin@MikroTik] /system/scheduler> add interval=24h name="set-128k" \
 \... start-time=17:00:00 on-event=stop_limit 
[admin@MikroTik] /system/scheduler> print
 Flags: X - disabled 
# NAME ON-EVENT START-DATE START-TIME INTERVAL RUN-COUNT
 0 set-64k start... 2008-10-30 09:00:00 1d 0 
1 set-128k stop_... 2008-10-30 17:00:00 1d 0 
[admin@MikroTik] /system/scheduler>
```

The following example schedules a script that sends each week a backup of router configuration by e-mail.

```ros
[admin@MikroTik] /system/script> add name=e-backup source={/system/backup 
{... save name=email; /tool/e-mail/send to="root@host.com" subject=([/system 
{... /identity/get name] . " Backup") file=email.backup} 
[admin@MikroTik] /system/script> print 
0 name="e-backup" source="/system/backup/save name=ema... owner=admin run-count=0 

[admin@MikroTik] /system/script> ../scheduler 
[admin@MikroTik] /system/scheduler> add interval=7d name="email-backup" \
 \... on-event=e-backup 
[admin@MikroTik] /system/scheduler> print
 Flags: X - disabled
 # NAME ON-EVENT START-DATE START-TIME INTERVAL RUN-COUNT 
0 email-... e-backup 2008-10-30 15:19:28 7d 1 
[admin@MikroTik] /system/scheduler>
```

Do not forget to set the e-mail settings, i.e., the SMTP server and From: address under `/tool/e-mail`. For example:

```ros
[admin@MikroTik] /tool/e-mail> set server=159.148.147.198 from=SysAdmin@host.com 
[admin@MikroTik] /tool/e-mail> print
 server: 159.148.147.198 
from: SysAdmin@host.com 
[admin@MikroTik] /tool/e-mail>
```

The example below will put 'x' in logs each hour from midnight till noon:

```ros
[admin@MikroTik] /system/script> add name=enable-x source={/system/scheduler 
{... enable x} 
[admin@MikroTik] /system/script> add name=disable-x source={/system/scheduler 
{... disable x} 
[admin@MikroTik] /system/script> add name=log-x source={:log info message=x} 
[admin@MikroTik] /system/script> .. scheduler 
[admin@MikroTik] /system/scheduler> add name=x-up start-time=00:00:00 \ 
\... interval=24h on-event=enable-x 
[admin@MikroTik] /system/scheduler> add name=x-down start-time=12:00:00
 \... interval=24h on-event=disable-x 
[admin@MikroTik] /system/scheduler> add name=x start-time=00:00:00 interval=1h \ 
\... on-event=log-x 
[admin@MikroTik] /system/scheduler> print 
Flags: X - disabled
 # NAME ON-EVENT START-DATE START-TIME INTERVAL RUN-COUNT 
0 x-up enable-x 2008-10-30 00:00:00 1d 0 
1 x-down disab... 2008-10-30 12:00:00 1d 0 
2 x log-x 2008-10-30 00:00:00 1h 0 
[admin@MikroTik] /system/scheduler>
```
