#!/usr/bin/env node

var program = require('commander')
    , debug = require("debug")("reaper")
    , debugErr = require("debug")("reaper:error")
    , moment = require("moment")
    , AWS = require('aws-sdk')
    , async = require("async")

    , STOP_THRESHOLD = 32 * 1024
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

function getNetworkTraffic(region, instanceId, statsKey, sampleHours, cb) {

    // i-932578f3
    var cloudwatch = new AWS.CloudWatch({region:region});

    var dimension =  [{Name: 'InstanceId', Value: instanceId}]

    async.auto({

        /* REQUEST data byte count */
        NetworkOut: function(dataCB) {
            cloudwatch.getMetricStatistics({
                Namespace: 'AWS/EC2'
                , MetricName: 'NetworkOut'
                , Dimensions: dimension
                , StartTime: moment().subtract('hours', sampleHours+1).toDate()
                , EndTime : moment().subtract('hours', 1).toDate()
                , Period : sampleHours * 3600
                , Statistics: [ statsKey ]
            }, function(err, data) {
                if (err) return dataCB(err);
                if (data.Datapoints.length == 0) return(null, 0);
                return dataCB(null, Math.floor(data.Datapoints[0][statsKey]));
            });
        },

        /* RESPONSE data byte count */
        NetworkIn: function(dataCB) {
            cloudwatch.getMetricStatistics({
                Namespace: 'AWS/EC2'
                , MetricName: 'NetworkIn'
                , Dimensions: dimension
                , StartTime: moment().subtract('hours', sampleHours+1).toDate()
                , EndTime : moment().subtract('hours', 1).toDate()
                , Period : sampleHours * 3600
                , Statistics: [ statsKey ]
            }, function(err, data) {
                if (err) return dataCB(err);
                if (data.Datapoints.length == 0) return(null, 0);
                return dataCB(null, Math.floor(data.Datapoints[0][statsKey]));
            });
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
            getNetworkTraffic('us-east-1', instance.InstanceId, 'Sum', 12, function(err, data) {
                if (err) {
                    debugErr("getNetworkStats Error: %s", err);
                    return;
                }

                // average data / hr the past 12 hours
                var avgRequestData = Math.floor(data.NetworkOut / 12)
                    , avgResponseData = Math.floor(data.NetworkIn / 12) ;

                debug("(%s) %s ==> IN: %s || OUT: %s" 
                    , instance.InstanceId
                    , extractTag(instance.Tags, "Name", "") 
                    , avgRequestData, avgResponseData);

            });
        }(instance));
    }

});
