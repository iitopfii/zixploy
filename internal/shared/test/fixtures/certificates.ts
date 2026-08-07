/**
 * Certificate fixtures สำหรับเทสต์ TLS — docs/phase-05-domains.md M5
 *
 * สร้างครั้งเดียวด้วย openssl แล้ว commit เป็นค่าคงที่ (ไม่ generate ตอนรันเทสต์)
 * เพราะเทสต์ต้องไม่ต้องพึ่ง openssl binary ในเครื่อง/CI และผลลัพธ์ต้อง deterministic
 *
 * ทุกใบเป็น self-signed ของ example.com — RFC 2606 reserved domain ที่ออกให้ไม่ได้จริง
 * จึงไม่มีทางที่ key เหล่านี้จะมีค่าอะไรถ้าหลุด
 *
 * VALID_CERT/VALID_KEY หมดอายุปี 2126 — เทสต์ expiry ใช้ options.now แทนการมี fixture
 * ที่หมดอายุจริง (fixture หมดอายุจะทำให้เทสต์ "ผ่านด้วยเหตุผลผิด" เมื่อเวลาผ่านไป)
 *
 * คำสั่งที่ใช้สร้าง (บันทึกไว้เผื่อต้องสร้างใหม่):
 *   openssl req -x509 -newkey rsa:2048 -nodes -keyout valid.key -out valid.crt \
 *     -days 36500 -subj "/CN=example.com" \
 *     -addext "subjectAltName=DNS:example.com,DNS:www.example.com"
 *   openssl req -x509 -newkey rsa:2048 -nodes -keyout wildcard.key -out wildcard.crt \
 *     -days 36500 -subj "/CN=*.example.com" -addext "subjectAltName=DNS:*.example.com"
 *   openssl genrsa -out other.key 2048
 *   openssl genrsa -aes256 -passout pass:secret -out encrypted.key 2048
 */

/** self-signed, CN=example.com, SAN: example.com + www.example.com, หมดอายุ 2126 */
export const VALID_CERT = `-----BEGIN CERTIFICATE-----
MIIDODCCAiCgAwIBAgIUSsb4jpdE9RSCJthp7+op2IZ6aMwwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wIBcNMjYwODA3MDYxMjU5WhgPMjEy
NjA3MTQwNjEyNTlaMBYxFDASBgNVBAMMC2V4YW1wbGUuY29tMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4P2JiJa3WJgmvwjnHGW5R1EKFDULn/wUZkLt
ESLNBUpNau2oCx1ZTOtPehiJjPaLMvmPZYbjjQ1NtI0OCKx86KA8zV/S3CcczXFu
VkYk6aRg7PFnUtwrM5IjOh5Hc/o2VhxMd5vOfxr9Po/10GH9hNpOp/XlH7+sEFok
2NkVkKvzo7MO1Ml9W+OPJUYzxVnjT4zdRZMi/0hlrAGZKHukDhtkd/NcD+C/amha
lbWU3RBZWzLzFFG6zB6rNz/8ChlMAtqx7JGoZli13HStIuXH9vgyO3e34tq/zgct
eatn+yBcMkU4t+bI7VmeU+z/j19tMGGnwurn8kzgLGUyW19nOwIDAQABo3wwejAd
BgNVHQ4EFgQUYx0KS+PBbVvWtBbYNqsWX3lKPkQwHwYDVR0jBBgwFoAUYx0KS+PB
bVvWtBbYNqsWX3lKPkQwDwYDVR0TAQH/BAUwAwEB/zAnBgNVHREEIDAeggtleGFt
cGxlLmNvbYIPd3d3LmV4YW1wbGUuY29tMA0GCSqGSIb3DQEBCwUAA4IBAQB6d59F
5G+BtztLD75DPDkXXIWk/zF8oPqxOJ2TKlUdfMY4r+ZG0Zo0ihAHXfoQUS0DKfVS
cqHEyinMfVUGnrxDKOkP1nT1osyan0a2xr2rKg9915I6Ed3XCzD9y6O6FfX7NccH
uXph2pIkkjg9ZtINKR7c8pvYNXTUqcDCrYWE52v2HLSbdue0TOeEtNFKcsRDRW+x
8CLdeEK87eHgLoiLIXxPCXxT9p8kh8oOvxkLHquV/bF7ipqGAKmWT7nZ9t0JPGUP
Cs/H8D5ZMh2FAxppu8k7f6LTc87rsaw6X1iZ0NvbRf8t7YuiMj+zRPi3lgbpem2l
Aed1nYTvvjrXwI8I
-----END CERTIFICATE-----
`;

/** private key คู่กับ VALID_CERT */
export const VALID_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDg/YmIlrdYmCa/
COccZblHUQoUNQuf/BRmQu0RIs0FSk1q7agLHVlM6096GImM9osy+Y9lhuONDU20
jQ4IrHzooDzNX9LcJxzNcW5WRiTppGDs8WdS3CszkiM6Hkdz+jZWHEx3m85/Gv0+
j/XQYf2E2k6n9eUfv6wQWiTY2RWQq/Ojsw7UyX1b448lRjPFWeNPjN1FkyL/SGWs
AZkoe6QOG2R381wP4L9qaFqVtZTdEFlbMvMUUbrMHqs3P/wKGUwC2rHskahmWLXc
dK0i5cf2+DI7d7fi2r/OBy15q2f7IFwyRTi35sjtWZ5T7P+PX20wYafC6ufyTOAs
ZTJbX2c7AgMBAAECggEANsIuS5KXDBZ3863IhfZSGkPkhpeEfUsececfCLkmGgAE
CJ7P8+iQN/LbdJVtQOQua9kmZ+jlEArpWySrgjvs6Lc7JScJzHAuh+fwGUpYKI9L
0c9NPPL+Br6uGTKOZHFE8T9Q8xl2MCRS93uVMcLvr3psg1+LBOejCpXN+wMWxw9F
odClQE2Dg+TENO5UyadMAgLg0jc0a2H/+uglvJDfJw2BL4X+7m8Q4nHjW+sw92Cf
/9qNHW5hC47fYAW/VQ2o23fplm9F2/fb2sFjAhLTkUBT1DRj2b1wcP5GeRym8EUa
vasNAC0cjbv5w17cIKW09dlOer1VIdpQA4xeskYvkQKBgQD/Ky1AvQlipvZ0Od20
fKb0VKf5KlnE+CfFfqBU0qPiFPzXqxBlgfjNe8MQIp2upk3S2rHYdBd9tbZRiMQI
6ZP5UUTXj+4/dadW+Sf/M/snj+dQ4dDv5TG0JpJSJJZVGsObmEmHllPWgajF+Hs6
VRTZu50hH0Kep7ERTOOYlaNHCwKBgQDhuTC3fNfJ26xudHCEvblBJjrhN0U73WAk
9y+t4egJXPpOWcaKNlbTteXSVDyx6C/0M6I5FJRdpz2zDkZKP2yuInEz46iEW2+D
hPa8wXl9hHZqyGonG2dZ9BUCPx3JswNpalfWmnt2bnmWExk/o2c09HJIQOgob1Co
YVVxs76+kQKBgQChy2vXN8YCsqFk0ug8MCnglOkpOWxQU5VMSd05y5I0oWAtE//C
jWYITOhDi991xWdlQlwwRnQ6toSTMGg0yn6UQK6pDE9iF6TypetxizE+RaXDiFvm
MOqSMz7mLOLRtbXALBC7k1s3kWFFnifstdQRtz+Lp/mjBetlb96EeqVcPwKBgEmV
CSCHfgC7r7ZCFvvurRlj0QXh8pvVSqZCPjS809tZh+9KrMIZfKx/O3AZLcABJMDC
pDtfTg5Jmn9oQ9moW1FYwPZdXG3pMKz7B0P4/hXAvKmKs7AT6tkUDFUzJg6+YHpY
xFGdAmpVESWvDCgGqHpGxYpwPj4QK4b4U9ZA9glBAoGADD/LGkTmCAc417aM5Zkk
I7H6uRp4BRWUtj1vcZVt1RylMcu6mmB9yQdBgEn5VKrFtpmKUL2vv7BtNCPcSveA
W2b8NaxzCoeKt6WcWuwTYXl+x0fAue7zM2s07zPbb32raWEpW0v4YpZwDRwETKRp
D2Gzna5WHABYEdQzQEtZBNI=
-----END PRIVATE KEY-----
`;

/**
 * self-signed wildcard *.example.com — ครอบ www.example.com แต่ไม่ครอบ example.com
 *
 * ใบนี้ **ไม่มี subject** (SAN-only) โดยบังเอิญตอนสร้าง แต่เก็บไว้แบบนี้โดยตั้งใจ:
 * cert ที่ไม่มี CN ถูกต้องตาม RFC 5280 และพบมากขึ้นเรื่อย ๆ (CA สมัยใหม่ deprecate CN
 * สำหรับ hostname ไปแล้ว) — เป็น regression test ว่า parseCertificate ไม่พังกับเคสนี้
 */
export const WILDCARD_CERT = `-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgIUTkOdTheC3HTI+E3jnlseTF5a+xgwDQYJKoZIhvcNAQEL
BQAwADAgFw0yNjA4MDcwNjEzMThaGA8yMTI2MDcxNDA2MTMxOFowADCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKIzxz+vn4+owkA1s5hdcGyxifjK49GV
2CbfyruG/TVBPphhiHCLnobVwoShZPT8IVPtaFbX70itg0D4ecbPrudPzWhVuWrS
GR5I1oStNXMfvsX1iIkEfHohFQbK3GnwbcWHcOD5w4IW2WxLQAzEu2NAdkhdPDgH
aZxBK78iri2EDHM9PeLlJNHj6Mn0MeH77sVhdC+RfAmFKwL7OefXolI+7EkJC7UK
EzMbOXmX2+mkojK+Da1oYUsIN872SApT8BDDzeRrYKJH3B93cEaAZ9iwTr7T+HnI
OLRnlezeL/Mx7gmo0Dl6OfBdsrkp4WtJkDpHI3NZKCc84oRuJohzxY0CAwEAAaNt
MGswHQYDVR0OBBYEFIOKM0JjlMMAsgqxQSsJbU8jK0epMB8GA1UdIwQYMBaAFIOK
M0JjlMMAsgqxQSsJbU8jK0epMA8GA1UdEwEB/wQFMAMBAf8wGAYDVR0RBBEwD4IN
Ki5leGFtcGxlLmNvbTANBgkqhkiG9w0BAQsFAAOCAQEAmDnmUH83phhNtQpQMnIF
nbycCKsXZWbtUmA3ueQq4lBLKDdX3Qm71N4L2u8ec0qVgE2OzHfynsl8zywmvkiM
mPEeJW7bGXoTO7C7USx/+V84e+iu3AGb2/Gmjl6uIkB0BF0CXE8BvHx+QrPV0jqM
yeySY6Wm5CiAMV1RWFoPJnNN52X8LurKxY/Fd9adEy1CM1zPX3I3ALmtCTDZT85G
ZsoJ7ZNMa63GrDT1/MCA+ibF+czWVnOAKeUHkyLdTYYXndF8zckgsrleuYV8EaBo
/In3Hh0xGmL19e0PWShV3H7kvdd/AJ31Oe7zgdPSHYpPQdkrki5nrQAH+IgyYYAN
Mw==
-----END CERTIFICATE-----
`;

/** private key คู่กับ WILDCARD_CERT */
export const WILDCARD_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCiM8c/r5+PqMJA
NbOYXXBssYn4yuPRldgm38q7hv01QT6YYYhwi56G1cKEoWT0/CFT7WhW1+9IrYNA
+HnGz67nT81oVblq0hkeSNaErTVzH77F9YiJBHx6IRUGytxp8G3Fh3Dg+cOCFtls
S0AMxLtjQHZIXTw4B2mcQSu/Iq4thAxzPT3i5STR4+jJ9DHh++7FYXQvkXwJhSsC
+znn16JSPuxJCQu1ChMzGzl5l9vppKIyvg2taGFLCDfO9kgKU/AQw83ka2CiR9wf
d3BGgGfYsE6+0/h5yDi0Z5Xs3i/zMe4JqNA5ejnwXbK5KeFrSZA6RyNzWSgnPOKE
biaIc8WNAgMBAAECggEADPTb3p91vHD7i0t+3BXirBwGbGQwjIZOrNRFinM++KkM
ifmIf4z3jce3cQa/XL5jHyQgqIc5KvIJQQBYIeRnET0TqFjopbrAnOWulQyM73RC
tedmD6PXGZ5Y4qEDuEanThcCkkYBMvwGRBtCs4JngYcdq6we6k7VRdEC4JKxnRsF
l5jyFGmHL7Pr3Z3chj8z0e6jDuOOz1CayUwaUbV4DSbntyhUrV/LmEw0ia9uSbF7
LwydmchAhMyzVfcHhVHXYwjM4iVisV1RndtcF2gxU3kt1orDcsElx4antpM7YSlK
H7UIpYZYWOTEhX664lxZskZZ2eUthAfzN/LU1yQKAQKBgQDV+ZBmNK1aWVESCC05
O+PUrN62lWVlqpkccGa1bIRbINgwXoRzig4fnnL7axxqW22yOBy79WzopBkj5bZl
qi5ibTtT28HVuaTE6ozBq3K3IrjNjYPxjV1ZJ2A1KpmetyP4Y0NckfCj63+xpNdE
vkIimay3UPIVFH8BndFeSSqmgQKBgQDCDyQhHP/Rc9+vN9bO+rUSp/c5isl3sPVw
6yV7DY0weOXJdXH4kUNl9QDPsOLSqwdpOqb1w6DK//kYkrmHG6qth1tLrX8amAvv
yI1IUJx+/oMag0qM8AHOc4einjrjE6EKrYc5ukRlfzakfup7XpRPnr4dSv1UP7Vb
gI1jdlrRDQKBgQDEOSzWzY/7vtS9uIngZq+0JSPIRJDL/vqSPfGyhmWKPECFeuf0
HLJ/BItlTQCt+FJMkXCoXZUWcwYrCUmPSdVnpcw2Rt0m5ivX+VBDerqkf08CEbji
F0V3sMhleT+PcVunOUBY7+zCJgDgI87V17RGjq75HV4jPryJ+vQ5htd6AQKBgQCu
N5Gj+LjhfTmPwH2kjAcLnKeijSqZvdBbc3/OnTfoEGGbH0kWcrMjUXVM/+xiXRDm
M7W4Zcxw8qTanr7YwMnVx/L6WeQGKAJvXokYJuaYTD2/C6deKAo3IhjesVcEjZbC
U09XUBYfWLnhq98uqpZTdJwRCEWt4RQb9aj5ZkPZ8QKBgHKOYiUDp57qQCBQXpxq
C0Hb0nOxVH/mUAel6jHge8kByoGs8az51vK9XOSs7G+ymjUz3KudTwPLd67NQLRK
GfvUP+6nX7jU4x8wtvs1HzOi4vVkyKVZ8RnzLLGZesWCr2oJXVPhSdZjMEEsSTM+
ydoBmVwrCBXQ3mE5xtqYz2ro
-----END PRIVATE KEY-----
`;

/** key ที่ไม่เกี่ยวกับ cert ใบไหนเลย — ใช้เทสต์ cert/key mismatch */
export const UNRELATED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDnxw/NPfPV9TRO
Ex5McRm6EuLHuP9L+6Def0d1RbWnm1ga8+9XF3HZlqim8sWkcBRQPdvpehaRMWCc
ADHE38g3yFA01hlLub37nTyrzlPOLLhmtwQ90SGR6FeGTYNcSTGgUOkxsBQqzDLa
orSJrMXGcdO6yQHvsbvM1+Dig8OHETg4Zo+GiiBl00WJaOdc9ZNYQXAap0sPns2K
iYwHuh1RfyUGcF6xXHy1OftkyJhL903wZdceFZpOz66AMOsUsEnL+xYykUv3cXy1
XX3Q1V5I5E8Pz4DRNBfsg+pAuKz9nvoGJnyOu5lWB2yo12kZ4fcN93mSn6oSsT6F
X2hVTlG/AgMBAAECggEAMZNwm9P+jetO7sxEFNG0UQqtG09EvDnsZOsQm9L3Ugx2
Qf2fWh+XqJUDKgKPp+aZUbiJi10j6paHNZcNDjFXoCbmkQaijoICUwmE6rLNVjJW
lxHahGZxKcZqwj1eNaUqSkJEPu6MwcK/tehLeY9NFm9OfIt2MJDxvJUIcyr/7amn
AYzX18lf7O7Pbu88/onEwfzMXq1/JVQzVrdNTQsa4fbAFLeoxBqN5LTgyYS9pn4c
TOo387lmRwBl8sSyZLxcb897vrTw7WtnRavIKOfNzLYueKNcOQtUnHR1PZrL/pjG
G0ISJ58OFHEBuPse8Jk7J4EqsoTq1aToNx+zJeQo0QKBgQD52+Uizs/pf/s9taFv
b+NkcchUtsA19M+AM5S+M0jweFzB1gc+fwCtXtUCj/Mv2Lp8xGxgQaZGkADNr/5P
MVaFI/Dum4lkPcZiqqS131VhDiTQLgWJIjJiJ4wS3bt+I5K7CmW0ZdEWTb/auV4r
AFIWfd0XdwABejMKxYQ7ac3JYwKBgQDteWYwQhisBrPUAPKa66tOf5d9I6iXoMsg
Scu2tBxLLjTeNpaI/V/BLfKfhZWKuV5xDqLGoa3IsHpqj/B6eoL7n2KD9PWTmlMH
Ul0SOLkscjqicR0w6Pqqx4q2OKgNQqPPSn8fIVVZ85Y9ox8/a3u4X1+hQ7KzGr5z
hUW/uB/y9QKBgHrDF+nqQy0uvHqtawwdpVQMs6krwXTBO9J5hXOOLyA3gxuZ1SVX
sTV9ipsfrxSrH7V9rOH+X3v79Okat5ChZSk1Z4NU2ERwNbD0tsjFWmW9VUkT05R1
QNwJIkGCwERRph5QFXh1Li4PNVx6B1KJbcuvO5nz1gTjzYBVW4r1iS6RAoGAaZBW
wcsQBqCwHeUR85Yhv7JuWB2a21SKF19WpHAqR61RqRphDqJ7h3dybEFIubMvbViR
OXUzuIvizy4PO5LsWQiAFaK17BhlIlMVtnzqq/xXXlCkJlLa40HywpAq/EIMaaB3
JBKAS41B00KJKHsSM2KKMzjR3lZcJSQwXkpuQWUCgYEAovfoD1R6P7WfkOpOKXY/
royh0bozQsFohpz8qa61Q0ibuOK88hQHWihjGnbtWXLVmBYMlxUO4bNh3yJ2OJFr
Sr4wDRDPk3d/4Ws+GACMest9VqPtU2/DHK55J27YsvDpbJ/bsl88punO+AZXZsnD
WkteRHq157ii/4kmXyLqBp0=
-----END PRIVATE KEY-----
`;

/** key ที่มี passphrase — Traefik อ่านไม่ได้ ต้องถูกปฏิเสธตอนอัปโหลด (passphrase: secret) */
export const ENCRYPTED_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQ/3qQh8DKPJa2KMLO
YW4T5AICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEHsbJmoS1C2sgHdK
HcfagQAEggTQXAZQ3ynfDK2TEuWEcymQ1c+uX4iC5uBoWaO46s2UP2UzpENP6MNS
T718/1gmUSEQKj8LuMUugRFpVubxizVw6dD+GkIDwrzoltLvi5TMrhtBNHpo77bX
hSvf5TLT6p6n8zXU3Kid649LY70hS3bTz2L7tJ52pbGpJH7zbOXOu846PlrkRE58
ixoFDWQvaefcqGeU5TN8Sk827OjbBfZrLlZfUnJcpFZsZRphHRP6tKbhLspbMNpT
OeDFnxdryQUwRkKoi6XRoCaQjZhKZStOojeLv7cwX6vr+NmEq5xbIkJhVDSj2iAG
puDQfJvthvFoOQxUD4KW3lraMUrSkfFUiYOXkfLDFyzUsk0xMdjWD9zQaBcScPC2
7bx/G+ZqJqfA4aHEPBFcZ8Qg+jYCKmFkAcs0IsEWvLy3dFtxw8a/ox1Cx9JF3Y+t
LpT6mMQ1Z3RM23H24VHaW0H94UeEl11AhkGVBqtlt/YJZ1RszwuazJyq4m7+Aa58
/T66mEheGTxnlWX5A/eiicknmbwK/2w0VM6zYgIzkzqu+YIHT5/P3Vc/1ixogBka
ZOyHmzvnUMzNfsV8WBb/H7jiurj9/C7XrInviqHZgB+Fy0mjihb2365iirNt/Jsz
kmn7oPSw22kAsBVtQwEYwxgIDc1hVbzbvzz3RF7UJ1BE7XwvjqH9X/XEkKrnOnSc
3mwTYNAPwNqfAC+Lih0sbk2MOabUTPXYLRSlHYqxYuUAzeomyzJhQRdU4G3sMfal
Rn4QjbZdssXtAX47Ow8WrZVAUMXbaxaQVVL9ED+EThZO7gEYu0pt0D4tNCzWybyr
qDpLzM1kCVWU+ZOPcfWi6W+8Yl+0PjEYdosqSYRfJuG8smp2RfKHHvb7KNzPED8h
Fmque1/Q0zNJUMnD1p14Ym3IkmOZtB+ebrP9HHv1K7jCMxPdqz0MtPYvUWhRFnnP
oqEjRKwMO+TJ0ZKzYt12mqiZ+vW+3ehWUkRQ5xMpgHrH15YzJHfjT3Zv03eYpz9Z
OfuJIqrG2x2ewZA6y8i7zq6GVX44KbEzGFumV2KTSECLv56zTJfa0ABe8XFddRAh
i8bOlohhtRK0PNN+s66nqfr+ja0iTzsWxU/p2x24MMOlShVoOGtzwTWADfyNmgK7
yo+P0YLlB4roc9hpB1tw9OrK48wdJJlA9/dE40mnHRBPep157Ia84Vhya7PWR1zp
cfey95Dj1QwFOm78mz4fIKDjpkyLvw5VvrKz/Ks//onKHkBS24nxAq8ZwZEguDCa
NJkARDzG+7wZNMKbxKAnubp1KGPEBkO2sRLhqf1FEXTv3EViFxtvJOo0+cRyEIEX
U/Pv/o3oUtqpeGewXPfdrVzNNZMaFy4rG2FduUaybnq3gl1Xnx1M1x6ZGjMEtAsh
V92a0idhgqvOKoVynIcpmxSJWaNL3HDSnGQclxcSSRYA4tK4be7siQM1zt4CKX+j
Bsy9Su9zC/L+eRMKCIZehLj5+/FqmfvCICsvFMwQ20VaRPYasL6154z4mCz3QTEk
Ha19JnA7ovjahffHnUX2Wh5gd01SzrWlH8k/OA8UqGt2zN+DWseeR3d7uPhiTIvO
kRVnHCSziQ+kgPs/1bICwBqKf12+nWon1Xg/qabiVYsIS75igcZ4sG8=
-----END ENCRYPTED PRIVATE KEY-----
`;
