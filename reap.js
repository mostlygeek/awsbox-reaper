#!/usr/bin/env node

var program = require('commander')
    , debug = require("debug")("reaper")
    , debugErr = require("debug")("reaper:error")
    , moment = require("moment")
    , AWS = require('aws-sdk')
    , async = require("async")
    , _ = require("underscore")

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

//getMedianTraffic('us-east-1', 'i-932578f3', 12, console.log.bind(console));

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

        var samplePeriod = 12; // hours

        debug("Instance: %s, %s hours", instance.InstanceId, hours);

        if (hours < samplePeriod) continue;

        (function(instance) {
            //debug("Getting NetworkIn for %s", instance.InstanceId);
            getMedianTraffic('us-east-1', instance.InstanceId, samplePeriod, function(err, data) {
                if (err) {
                    debugErr("get traffic Error: %s", err);
                    return;
                }

                if (data.NetworkOut < 1024) {
                    debug("(%s) %s ==> REQ: %s bytes || RES: %s bytes" 
                        , instance.InstanceId
                        , extractTag(instance.Tags, "Name", "") 
                        , data.NetworkOut, data.NetworkIn);
                }
            });
        }(instance));
    }

});
