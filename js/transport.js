SSHyClient.Transport = function(ws) {
    this.local_version = 'SSH-2.0-SSHyClient'
    this.remote_version = ''

    // Kex variables
    this.local_kex_message = null // Our local          - kex init message containing algorithm negotiation
    this.remote_kex_message = null // The remote servers ^
    this.K = null // Our secret key K generated by our preferred_kex algorithm
    this.H = null // A hash used for encryption key generation by the preferred_keys algorithm

    // Our supported Algorithms
    this.preferred_algorithms = ['diffie-hellman-group-exchange-sha1,diffie-hellman-group14-sha1,diffie-hellman-group1-sha1',
        'ssh-rsa',
        'aes128-ctr',
        'hmac-sha1',
        'none'
    ]

    // Objects storing references to our different algorithm modules
    this.preferred_kex = null
    this.preferred_keys = null
    this.preferred_cipher = null
    this.preferred_mac = null
    this.preferred_compression = null

    this.session_id = null

    this.parceler = new SSHyClient.parceler(ws, this)
    this.auth = new SSHyClient.auth(this.parceler)
}

SSHyClient.Transport.prototype = {

    kex_info: {
        'diffie-hellman-group1-sha1': function(self) {
            return new SSHyClient.dhGroup1(self, 1)
        },
        'diffie-hellman-group14-sha1': function(self) {
            return new SSHyClient.dhGroup1(self, 14)
        },
        'diffie-hellman-group-exchange-sha1': function(self) {
            return new SSHyClient.dhGroupEx(self)
        }
    },

    // Handles inbound traffic over the socket
    handle: function(r) {
        /* Checking for encryption first since it will be the most common check
        	- Parceler should send decrypted message ( -packet length -padding length -padding ) to transport.handle_dec()
         	  from there it should be send to the relevant handler (auth/control)		*/
        if (this.parceler.encrypting) {
            this.parceler.inbound_buffer += r
            this.parceler.decrypt()
            return
        }

        /* If we don't have a remote version set then this is the first message so we need to send our local version
           and store the remote version */
        if (!this.remote_version) {
            this.parceler.send(this.local_version + '\r\n', true)
            this.remote_version = r.slice(0, r.length - 2) // Slice off the '/r/n' from the end of our remote version
            this.send_kex_init()
            return
        }

        this.parceler.inbound_sequence_num++

            // Now we have one message we should check the code and see what to do with it.
            try {
                this.handler_table[r.substring(5, 6).charCodeAt(0)](this, r)
            }
        catch (err) {
            console.log(err)
            console.log("Error! code - " + r.substring(5, 6).charCodeAt(0) + " does not exist!")
        }
    },

	/*
		A table storing various function calls corresponding to the Message ID numbers defined [https://www.ietf.org/rfc/rfc4250.txt]
		called like :
			`handler_table[id](<object> SSHyClient.transport, <string> message)`
	*/
    handler_table: {
		/* SSH_MSG_DISCONNECT - sent by the SSH server when the connection is gracefully closed */
        1: function(self, m) {
            term.write("Connection to " + document.getElementById('ipaddress').value + " closed.")
        },
		/* SSH_MSG_IGNORE - sent by the SSH server when keys are not to be echoed */
		2: function(self, m){
			return
		},
		/* SSH_MSG_SERVICE_ACCEPT: sent by the SSH server after the client request's a service (post-kex) */
        6: function(self, m) {
			var service = new SSHyClient.Message(m.slice(1)).get_string()
            // Check th type of message sent by the server and start the appropriate service
            if ( service == "ssh-userauth") {
                self.auth.ssh_connection()
            }
        },
		/* SSH_MSG_KEXINIT: sent by the server after algorithm negotiation - contains server's keys and hash */
        20: function(self, m) {
            // Remote_kex_message must have no padding or length meta data so we have to strip that out
            var m = new SSHyClient.Message(m).get_string()
            self.parse_kex_reply(m)
            self.remote_kex_message = self.cut_padding(m) // we need this later for calculating H
            self.preferred_kex.start()
        },
		/* SSH_MSG_KEX_DH_GEX_GROUP: used for DH GroupEx when negotiating which group to use */
        31: function(self, m) {
            /* Since we're just extracting data from r in parse_reply, we don't need to do the processing to remove the padding
			 and can just remove the first 6 bytes (length, padding length, message code) */
            self.preferred_kex.parse_reply(31, m.slice(6))
        },
		/* SSH_MSG_KEX_DH_GEX_REPLY: used for DH GroupEx, sent by the server - contains server's keys and hash */
        33: function(self, m) {
            self.preferred_kex.parse_reply(33, m.slice(6))
        },
		/* SSH_MSG_USERAUTH_FAILURE: sent by the server when there is a complete or partial failure with user authentication */
        51: function(self, m) {
            self.auth.auth_failure()
        },
		/* SSH_MSG_USERAUTH_SUCCESS: sent by the server when an authentication attempt succeeds */
        52: function(self, m) {
            self.auth.authenticated = true
            self.auth.auth_success(true)
        },
		/* SSH_MSG_GLOBAL_REQUEST: sent by the server to request information, server sends its hostkey after user-auth
		   but RSA keys (TODO) aren't implemented so for now we can ignore this message */
        80: function(self, m) {
            return
        },
		/* SSH_MSG_CHANNEL_OPEN_CONFIRMATION: sent by the server to inform the client that a new channel has been opened */
        91: function(self, m) {
            self.auth.get_pty('xterm-256color', term_cols, term_rows)
        },
		/* SSH_MSG_CHANNEL_WINDOW_ADJUST: sent by the server to inform the client of the maximum window size (bytes) */
        93: function(self, m) {
			// Slice the first 5 bytes (<1b> flag + <4b> channel_id) and increase our window size by the ammount specified
			SSHyClient.WINDOW_SIZE += new SSHyClient.Message(m.slice(5)).get_int()
            return
        },
		/* SSH_MSG_CHANNEL_DATA: text sent by the server which is displayed by writing to the terminal */
        94: function(self, m) {
			// Slice the heading 9 bytes and send the remaining xterm sequence to the terminal
            term.write(m.slice(9))
        },
		/* SSH_MSG_CHANNEL_EOF: sent by the server indicating no more data will be sent to the channel*/
        96: function(self, m) {
            term.write("logout\n\r")
			// TODO: Close the SSH channel
        },
		/* SSH_MSG_CHANNEL_CLOSE: sent by the server to indicate the channel is now closed; the SSH connection remains open*/
        97: function(self, m) {
            term.write("Connection to " + html_ipaddress + " closed.")
			// TODO: Close the SSH connection
        },
		/* SSH_MSG_CHANNEL_REQUEST: sent by the server to request a new channel, as the client we can just ignore this*/
		98: function(self, m){
			return
		}
    },

    cut_padding: function(m) {
        return m.substring(1, m.length - m[0].charCodeAt(0))
    },

    send_packet: function(m) {
        this.parceler.send(m)
    },

    send_kex_init: function() {
        var m = new SSHyClient.Message()
        m.add_bytes(String.fromCharCode(SSHyClient.MSG_KEX_INIT))
        // add 16 random bytes
        m.add_bytes(read_rng(16))
        m.add_string(this.preferred_algorithms[0]) // Preferred Kex
        m.add_string(this.preferred_algorithms[1]) // Preferred Server keys
        m.add_string(this.preferred_algorithms[2]) // Preferred Ciphers
        m.add_string(this.preferred_algorithms[2])
        m.add_string(this.preferred_algorithms[3]) // Preferred Macs
        m.add_string(this.preferred_algorithms[3])
        m.add_string(this.preferred_algorithms[4]) // Preferred Compression
        m.add_string(this.preferred_algorithms[4])

        m.add_string('') // Languages
        m.add_string('')
        m.add_boolean(false) // Kex guessing
        m.add_int(0)
        //save a copy for calculating H later
        this.local_kex_message = m.toString()

        this.send_packet(m.toString())
    },

    parse_kex_reply: function(m) {
        m = new SSHyClient.Message(m)
        var random = m.get_bytes(18)
        var kex_algorithms = m.get_string().split(',')
        var server_keys = m.get_string().split(',')
        var client_cipher = m.get_string().split(',')
        var server_cipher = m.get_string().split(',')
        var client_mac = m.get_string().split(',')
        var server_mac = m.get_string().split(',')

        function filter(client, server) {
            client = client.split(',')
            for (var x = 0; x < client.length; ++x) {
                if (server.indexOf(client[x]) != -1) {
                    return client[x];
                }
            }
        }

        var kex = filter(this.preferred_algorithms[0], kex_algorithms)
        var keys = filter(this.preferred_algorithms[1], server_keys)
        var cipher = filter(this.preferred_algorithms[2], server_cipher)
        var mac = filter(this.preferred_algorithms[3], server_mac)

        if (!kex || !keys || !cipher || !mac) {
            var missing = ''
            if (!kex) {
                missing += "KEX Algorithm,"
            }
            if (!keys) {
                missing += "Host Keys,"
            }
            if (!cipher) {
                missing += "Encryption Cipher,"
            }
            if (!mac) {
                missing += "MAC Algorithm"
            }

            display_error("Incompatable ssh server (no compatable - " + missing + " )")
            throw "Chosen Algs = kex=" + kex + ", keys=" + keys + ", cipher=" + cipher + ", mac=" + mac
        }

        // Set those preferred Algs
        this.preferred_kex = this.kex_info[kex](this)
    },

    /* 	Takes a character and size then generates a key to be used by ssh
    	A = Initial IV 		client -> server
    	C = Encryption Key 	client -> server
    	E = Integrity Key 	client -> server
    */
    generate_key: function(char, size) {
        var m = new SSHyClient.Message()
        m.add_mpint(this.K)
        m.add_bytes(this.H)
        m.add_bytes(char)
        m.add_bytes(this.session_id)

        return new SSHyClient.hash.SHA1(m.toString()).digest().substring(0, size)
    },

    activate_encryption: function() {
        // Generate the keys we need for encryption and HMAC
        this.parceler.outbound_enc_iv = this.generate_key('A', 16)
        this.parceler.outbound_enc_key = this.generate_key('C', 16)
        this.parceler.outbound_mac_key = this.generate_key('E', 20)

        this.parceler.outbound_cipher = new SSHyClient.crypto.AES(this.parceler.outbound_enc_key,
            SSHyClient.cipher_mode.AES_CTR,
            this.parceler.outbound_enc_iv,
            new SSHyClient.crypto.counter(128, inflate_long(this.parceler.outbound_enc_iv)))

        this.parceler.inbound_enc_iv = this.generate_key('B', 16)
        this.parceler.inbound_enc_key = this.generate_key('D', 16)
        this.parceler.inbound_mac_key = this.generate_key('F', 20)

        this.parceler.inbound_cipher = new SSHyClient.crypto.AES(this.parceler.inbound_enc_key,
            SSHyClient.cipher_mode.AES_CTR,
            this.parceler.inbound_enc_iv,
            new SSHyClient.crypto.counter(128, inflate_long(this.parceler.inbound_enc_iv)))

        // signal to the parceler that we want to encrypt and decypt
        this.parceler.encrypting = true
        this.parceler.block_size = 16

        this.auth.request_auth()
    },

    handle_dec: function(m) {
        // Cut the padding off
        var m = this.cut_padding(m)

        // Should now be in format [ptype][message]
        try {
            this.handler_table[m.substring(0, 1).charCodeAt(0)](this, m)
        } catch (err) {
            console.log(err)
            console.log("Error! code - " + m.substring(0, 1).charCodeAt(0) + " does not exist!")
        }
    },

    expect_key: function(command) {
        this.auth.send_command(command)
    },

    send_new_keys: function() {
        var m = new SSHyClient.Message()
        m.add_bytes(String.fromCharCode(SSHyClient.MSG_NEW_KEYS))

        this.send_packet(m)
        this.activate_encryption()

        this.parceler.inbound_sequence_num++
    }
}
