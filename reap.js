#!/usr/bin/env node

var program = require("commander")
    , debug = require("debug")
    , debugInfo = debug("reaper:info")
    , debugErr  = debug("reaper:error")
    , debugSkip = debug("reaper:skip")
    , debugStop = debug("reaper:stop")
    , debugTerminate = debug("reaper:terminate")
    , moment = require("moment")
    , AWS = require("aws-sdk")
    , async = require("async")
    , _ = require("underscore")

    , STOP_THRESHOLD = 32 * 1024
    ;

program
    .version('0.0.1')
    .option('-r, --region [region]', 'AWS region', 'us-east-1')
    .option('-d, --dryrun', 'Makes real changes to AWS (stop, terminate, etc)', false)
    .option('-t, --tag [value]', 'search for instances by tag exists', 'AWSBOX')
    .option('-s, --securitygroup [group-id]', 'search for instances by security group', 'awsbox group v1')
    .parse(process.argv);

var DRY_RUN = (!!program.dryrun);

AWS.config.update({
    accessKeyId : process.env.AWS_ACCESS_KEY,
    secretAccessKey : process.env.AWS_SECRET_KEY
});

AWS.config.update({region: program.region});

AWS.config.apiVersions = {
  ec2: '2013-08-15',
  cloudwatch: '2010-08-01'
};

function fetchInstances(region, cb) {
    debugInfo("Fetching AWSBOXES in %s", region);
    var ec2 = new AWS.EC2({region:region});
    // http://docs.aws.amazon.com/AWSEC2/latest/CommandLineReference/ApiReference-cmd-DescribeInstances.html

    if (program.tag) {
        debugInfo("Searching with tag: %s", program.tag);
        var params = { Filters: [{Name: 'tag-key', Values: [program.tag]}] };
    } else if (program.securitygroup) {
        debugInfo("Searching with security group: %s", program.securitygroup);
        var params = { Filters: [{Name: 'group-id', Values: [program.securitygroup]}] };
    } else {
        var params = {};
    }

    var instances = [];
    ec2.describeInstances(params, function(err, data) {
        if (err) return cb(err);
        for (var i=0, l=data.Reservations.length; i<l; i++) {
            var r = data.Reservations[i];
            instances = instances.concat(r.Instances);
        }

        debugInfo("Fetched %d instances", instances.length);
        cb(null, instances);
    });
};

function getMedianTraffic(region, instanceId, sampleHours, cb) {

    var cloudwatch = new AWS.CloudWatch({region:region});

    var dimension =  [{Name: 'InstanceId', Value: instanceId}];
    var sortFn = function(a, b) { return a.Sum - b.Sum };

    function getDataMedian(metricName, cwCB) {
        cloudwatch.getMetricStatistics({
            Namespace: 'AWS/EC2'
            , MetricName: metricName
            , Dimensions: dimension
            , StartTime: moment().subtract('hours', sampleHours+1).toDate()
            , EndTime : moment().subtract('hours', 1).toDate()
            , Period : 300
            , Statistics: [ "Sum" ]
        }, function(err, data) {
            if (err) return dataCB(err);
            if (data.Datapoints.length == 0) return(null, 0);

            var d = _.pluck(data.Datapoints, "Sum");
            d.sort(sortFn);
            var middle = Math.floor(d.length / 2);
            if (d.length % 2 == 0) {
                return cwCB(null, (d[middle]+d[middle+1])/2)
            } else {
                return cwCB(null, d[middle+1]);
            }
        });
    }

    async.auto({
        /* REQUEST data byte count */
        NetworkOut: function(dataCB) {
            getDataMedian('NetworkOut', dataCB);
        },

        /* RESPONSE data byte count */
        NetworkIn: function(dataCB) {
            getDataMedian('NetworkIn', dataCB);
        }
    }, function(err, results) {
        if (err) return cb(err);
        cb(null, results)
    });
};

function extractTag(tags, key, defaultValue) {
    for(var i=0, l=tags.length; i<l; i++) {
        if (tags[i].Key == key) {
            return tags[i].Value;
        }
    }

    return defaultValue;
}

fetchInstances(program.region, function(err, instances) {
    if (err) {
        debugErr("Fetch Error: %s", err);
        return;
    }

    var now = moment()
    for(var i=0, l=instances.length; i<l; i++) {
        var instance = instances[i];
        var m = moment(instance.LaunchTime);
        var hours = now.diff(m, 'hours');

        instance.HoursOn = hours;

        var samplePeriod = 12; // hours

        //debugInfo("Instance: %s, %s hours", instance.InstanceId, hours);

        if (hours < samplePeriod) continue;

        (function(instance) {
            //debug("Getting NetworkIn for %s", instance.InstanceId);
            getMedianTraffic(program.region, instance.InstanceId, samplePeriod, function(err, data) {
                if (err) {
                    debugErr("get traffic Error: %s", err);
                    return;
                }

                // NetworkOut is the median amount of incoming data into the EC2 instance
                // every 1/2 hour (for the past 12 hours)
                if (data.NetworkOut < 1024) {
                    if (extractTag(instance.Tags, 'AWSBOX_SPAREME', false)) {
                        debugSkip("Sparing instance: %s %s", instance.instanceId, extractTag(instance.Tags, "Name", ""))
                    } else {
                        debugStop("%s(%s) (%d hours) %s  ==> REQ: %s bytes || RES: %s bytes" 
                            , ((DRY_RUN) ? "DRY RUN " : "")
                            , instance.InstanceId
                            , instance.HoursOn
                            , extractTag(instance.Tags, "Name", "") 
                            , data.NetworkOut, data.NetworkIn);

                        var ec2 = new AWS.EC2({region:program.region});

                        ec2.createTags({
                            DryRun: DRY_RUN
                            , Resources: [ instance.InstanceId ]
                            , Tags: [
                                {Key: 'AWSBOX_REAP', Value: JSON.stringify({STOP_AT : Date.now()})}
                            ]
                        }, function(err, response) {
                            if (err && err.code != 'DryRunOperation') { debugErr("Tagging Error: %s", err);}
                        });

                        ec2.stopInstances({
                            DryRun: DRY_RUN
                            , InstanceIds: [ instance.InstanceId ]
                            , Force: false // force the instance to stop w/out opportunity to gracefully shutdown
                        }, function(err, response) {
                            if (err && err.code != 'DryRunOperation') { debugErr("STOP Error: %s", err);}
                        });
                    }
                }
            });
        }(instance));
    }

});
