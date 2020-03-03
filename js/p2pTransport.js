// -*- coding: utf-8 -*-
// Copyright 2019, 2020 The Matrix.org Foundation C.I.C.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { pull } from "pull-stream"
import concat from "pull-stream/sinks/concat"

import PeerInfo from "peer-info"
import PeerId from "peer-id"

import { promisify } from "es6-promisify"


export default class P2pTransport {

    constructor(p2pLocalNode) {
        this.p2pLocalNode = p2pLocalNode
    }

    async roundTrip(req) {
        try {
            // figure out what address we're connecting to
            // we can't use the url npm module, as it lowercases the host
            // we can't use the browser's Url module, as it doesn't parse hosts for unknown URI schemes
            console.log("roundTrip: ", req.method, " ", req.url, " ", req.body);
            const host = (req.url.match(/^matrix:\/\/(.*?)\//))[1]
            const destPeerId = PeerId.createFromB58String(host)
            const destPeerInfo = new PeerInfo(destPeerId);
            destPeerInfo.multiaddrs.add('/ip4/127.0.0.1/tcp/9090/ws/p2p-websocket-star/');

            // dial out over libp2p
            const node = this.p2pLocalNode.node
            const dial = promisify(node.dialProtocol)
            console.log("Dialling ", JSON.stringify(destPeerInfo));

            const conn = await dial(destPeerInfo, '/libp2p-http/1.0.0')

            // the world's dumbest HTTP client.
            // it would be much better to hook up go's HTTP client (and then we'd get HTTP/2 etc)
            // but we can't because https://github.com/golang/go/issues/27495

            let reqHeaders = ''
            if (req.headers) {
                for (const header of req.headers) {
                    // FIXME: is this a safe header encoding?
                    reqHeaders += `${header[0]}: ${header[1]}\n`
                }
            }
            if (req.method === "POST" || req.method === "PUT") {
                reqHeaders += `Content-Length: ${new Blob([req.body]).size}`; // include utf-8 chars properly
            }

            if (reqHeaders.length > 0) {
                reqHeaders = `\r\n${reqHeaders}`
            }

            const reqString = `${req.method} ${req.url} HTTP/1.0${reqHeaders}\r\n\r\n${req.body}`
            pull(
                pull.values([reqString]),
                conn,
            )

            let respResolve
            const respPromise = new Promise((resolve, reject) => { respResolve = resolve })

            let respString
            pull(
                conn,
                concat((err, data) => {
                    if (err) throw err
                    respString = data
                    respResolve()
                }),
            )

            await respPromise
            const m = respString.match(/^(HTTP\/1.0) ((.*?) (.*?))(\r\n([^]*?)?(\r\n\r\n([^]*?)))?$/)
            if (!m) {
                console.warn("couldn't parse resp", respString)
            }

            const respHeaders = []
            const headerLines = m[6].split('\r\n')
            for (const headerLine of headerLines) {
                // FIXME: is this safe header parsing? Do we need to worry about line-wrapping?
                const match = headerLine.match(/^(.+?): *(.*?)$/)
                if (match) {
                    respHeaders.push([match[1], match[2]])
                }
                else {
                    console.log("couldn't parse headerLine ", headerLine)
                }
            }

            const resp = {
                "proto": m[1],
                "status": m[2],
                "statusCode": parseInt(m[3]),
                "headers": respHeaders,
                "body": m[8],
            }
            return resp;
            
        } catch (err) {
            console.error("P2pTransport round trip error: ");
            console.error(err);
        }
    }
}
