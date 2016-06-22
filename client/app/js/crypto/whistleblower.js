angular.module('GLBrowserCrypto')
.factory('glbcWhistleblower', ['$q', 'pgp', 'glbcCipherLib', 'glbcKeyLib', 'glbcKeyRing', function($q, pgp, glbcCipherLib, glbcKeyLib, glbcKeyRing) {

  var passphrase = null;

  var variables = {
    keyDerived: false,
  };

  return {
    variables: variables,

    unlock: function() {
      return glbcKeyRing.unlockKeyRing(passphrase);
    },

    lock: function() {
      return glbcKeyRing.lockKeyRing(passphrase);
    },

    storePassphrase: function(pass) {
      passphrase = pass;
    },

    clear: function() {
      passphrase = null;
      glbcKeyRing.clear();
    },

    initialize: function(armoredPrivateKey, receivers) {
      glbcKeyRing.initialize(armoredPrivateKey, 'whistleblower');
      if (passphrase === null) {
        throw new Error('WB key passphrase is null');
      }

      receivers = receivers.filter(function(rec) {
        return rec.ccrypto_key_public !== "";
      });
      receivers.forEach(function(rec) {
        glbcKeyRing.addPubKey(rec.id, rec.ccrypto_key_public);
      });

      variables.keyDerived = true; 
    },

    /**
     * @param {string} keycode
     * @param {string} salt
     * @param {Submission} submission
     * @return {Promise}
     **/
    deriveKey: function(keycode, salt, submission) {
      var self = this;
      var p = glbcKeyLib.deriveUserPassword(keycode, salt, 14).then(function(result) {
        submission.receipt_hash = result.authentication;
        glbcKeyLib.generateCCryptoKey(result.passphrase).then(function(keys) {
          var armored_priv_key = keys.ccrypto_key_private.armor();
          var success = glbcKeyRing.initialize(armored_priv_key, 'whistleblower');
          if (!success) {
            throw new Error('Key Derivation failed!');
          }

          self.storePassphrase(result.passphrase);
          self.unlock();

          submission.ccrypto_key_private = armored_priv_key;
          submission.ccrypto_key_public = keys.ccrypto_key_public.armor();

          variables.keyDerived = true;
        });
      });
      return p;
    },

   /** 
    * encrypts the passed file with the keys of the receivers and returns a 
    * new encrypted file with '.pgp' added as the extension.
    * @param {File} file 
    * @param {Array<Object>} receivers 
    * @return {Promise<File>}
    **/
    handleFileEncryption: function(file, receivers) {
      var deferred = $q.defer();

      glbcCipherLib.createArrayFromBlob(file).then(function(fileArr) {

        var pubKeys = receivers.map(function(rec) {
          return glbcKeyRing.getPubKey(rec.id);
        });
        
        var options = {
          data: fileArr,
          publicKeys: pubKeys,
          privateKey: glbcKeyRing.getKey(),
          format: 'binary',
          armor: false,
        };
        return pgp.encrypt(options);
      }).then(function(result) {

        var cipherTextArr = result.message.packets.write();

        // Note application/octet-stream must be explicitly set or the new File
        // will append leading and trailing bytes to the upload.
        var cipherBlob = new Blob([cipherTextArr.buffer], {type:'application/octet-stream'});
        var encFile = new File([cipherBlob], file.name);
        deferred.resolve(encFile);
      });
      return deferred.promise;
    },


    /**
     * @param {String} jsonAnswers a stringified JSON object containing the msg.
     * @param {Array<String>} receiverIds 
     * @return {Promise<String>} the armored pgp message
     */
    encryptAndSignAnswers: function(jsonAnswers, receiverIds) {

      var pubKeys = receiverIds.map(function(id) {
        return glbcKeyRing.getPubKey(id); 
      });
      pubKeys.push(glbcKeyRing.getPubKey('whistleblower'));

      var options = {
        data: jsonAnswers,
        privateKey: glbcKeyRing.getKey(),
        publicKeys: pubKeys,
        format: 'utf8',
        armor: true,
      };

      // TODO unlock keyring
      return pgp.encrypt(options).then(function(cipherMsg) {
        return cipherMsg.data;
      });
    },

    /*
     * @param {Array<String>} msgs a list of ASCII armored openpgp messages
     * @param {Array<pgp.Key>} pubKeys a corresponding list of public keys of the signer
     * @return {Promise<Array<String>>} the list of the decrypted msgs
     */
    decryptAndVerifyMessages: function(msgs, pubKeys) {
      var deferred = $q.defer();

      if (msgs.length !== pubKeys.length) {
        deferred.reject(new Error('mismatched msgs and pubkeys'));
      }

      var decPromises = [];
      for (var i = 0; i < msgs.length; i++) {
        var msg = pgp.message.readArmored(msgs[i]);
        var pubKey = pgp.key.readArmored(pubKeys[i]).keys[0];
        var options = {
          message: msg,
          privateKey: glbcKeyRing.getKey(),
          publicKeys: pubKey,
          format: 'utf8', 
        };
        var promise = pgp.decrypt(options).then(function(result) {
          return result.data; 
        });
        decPromises.push(promise);
      }
      
      return $q.all(decPromises);
    },

  };
}]);
