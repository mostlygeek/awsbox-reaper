# awsbox-reaper

Scripts for keeping AWS accounts clean of unused AWSBOXes

## Reaper Algorithm

1. Find all running AWSBOXes in AWS Account (all regions)
1. Check the network IO for the AWSBOX, if it is under the threshold, STOP it
1. Find all stopped AWSBOXes, TERMINATE them if they have been stopped for > 15 days

