#!/usr/bin/env node

var program = require('commander')
    , debug = require("debug")("reaper")
    , debugErr = require("debug")("reaper:error")
    , moment = require("moment")
    , AWS = require('aws-sdk')

    , STOP_THRESHOLD = 1024
    ;

AWS.config.update({
    accessKeyId : process.env.AWS_ACCESS_KEY,
    secretAccessKey : process.env.AWS_SECRET_KEY
});

AWS.config.update({region: 'us-east-1'});

AWS.config.apiVersions = {
  ec2: '2013-08-15',
  cloudwatch: '2010-08-01'
};


function fetchInstances(region, cb) {
    debug("Fetching AWSBOXES in %s", region);
    var ec2 = new AWS.EC2({region:region});
    var params = { Filters: [{Name: 'tag-key', Values: ['AWSBOX']}] };

    var instances = [];
    ec2.describeInstances(params, function(err, data) {
        if (err) return cb(err);
        for (var i=0, l=data.Reservations.length; i<l; i++) {
            var r = data.Reservations[i];
            instances = instances.concat(r.Instances);
        }

        debug("Fetched %d instances", instances.length);
        cb(null, instances);
    });
};

function getNetworkIn(region, instanceId, cb) {

    // i-932578f3
    var cloudwatch = new AWS.CloudWatch({region:region});

    var SAMPLE_HOURS = 12;

    cloudwatch.getMetricStatistics({
        Namespace: 'AWS/EC2'
        , MetricName: 'NetworkOut'
        , Dimensions: [{Name: 'InstanceId', Value: instanceId}]
        , StartTime: moment().subtract('hours', SAMPLE_HOURS+1).toDate()
        , EndTime : moment().subtract('hours', 1).toDate()
        , Period : SAMPLE_HOURS * 3600
        , Statistics: ["Average"]
    }, function(err, data) {
        if (err) return cb(err);

        // average bytes / hour for the past 12 hours
        return cb(null, Math.floor(data.Datapoints[0].Average));
    });
};

fetchInstances('us-east-1', function(err, instances) {
    if (err) {
        debugErr("Error: %s", err);
        return;
    }


    var now = moment()
    for(var i=0, l=instances.length; i<l; i++) {
        var instance = instances[i];
        var m = moment(instance.LaunchTime);
        var hours = now.diff(m, 'hours');
        debug("Instance: %s, %s hours", instance.InstanceId, hours);

        if (hours < 12) continue;

        (function(instance) {
            //debug("Getting NetworkIn for %s", instance.InstanceId);
            getNetworkIn('us-east-1', instance.InstanceId, function(err, bytes) {
                if (err) {
                    debugErr("getNetworkIn Error: %s", err);
                    return;
                }

                if (bytes < STOP_THRESHOLD) {
                    debug("%s => %s avg bytes/hr", instance.InstanceId, bytes);
                }

            });
        }(instance));
    }

});
