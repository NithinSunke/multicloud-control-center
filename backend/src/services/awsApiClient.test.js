import { describe, expect, it } from 'vitest';
import { parseEc2Instances } from './awsApiClient.js';

describe('awsApiClient EC2 parsing', () => {
  it('parses EC2 instances from nested AWS reservation XML', () => {
    const xml = `
      <DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
        <reservationSet>
          <item>
            <reservationId>r-1</reservationId>
            <instancesSet>
              <item>
                <instanceId>i-04939c8ab6a336ca9</instanceId>
                <instanceState>
                  <code>16</code>
                  <name>running</name>
                </instanceState>
                <placement>
                  <availabilityZone>ap-south-1a</availabilityZone>
                </placement>
                <instanceType>t3.micro</instanceType>
                <subnetId>subnet-123</subnetId>
                <vpcId>vpc-123</vpcId>
                <privateIpAddress>172.31.39.174</privateIpAddress>
                <ipAddress>3.108.218.53</ipAddress>
                <tagSet>
                  <item>
                    <key>Name</key>
                    <value>testvm</value>
                  </item>
                </tagSet>
              </item>
              <item>
                <instanceId>i-0495482d3872a2499</instanceId>
                <instanceState>
                  <code>16</code>
                  <name>running</name>
                </instanceState>
                <placement>
                  <availabilityZone>ap-south-1a</availabilityZone>
                </placement>
                <instanceType>t3.micro</instanceType>
                <privateIpAddressesSet>
                  <item>
                    <privateIpAddress>172.31.44.124</privateIpAddress>
                  </item>
                </privateIpAddressesSet>
                <tagSet>
                  <item>
                    <key>Name</key>
                    <value>tst</value>
                  </item>
                </tagSet>
              </item>
            </instancesSet>
          </item>
        </reservationSet>
      </DescribeInstancesResponse>
    `;

    const instances = parseEc2Instances(xml, 'ap-south-1');

    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      id: 'i-04939c8ab6a336ca9',
      name: 'testvm',
      status: 'running',
      region: 'ap-south-1',
      availabilityDomain: 'ap-south-1a',
      shape: 't3.micro',
      privateIp: '172.31.39.174',
      publicIp: '3.108.218.53',
    });
    expect(instances[1]).toMatchObject({
      id: 'i-0495482d3872a2499',
      name: 'tst',
      privateIp: '172.31.44.124',
    });
  });
});
