'use strict';

var _ = require('underscore');
var cos = require('./uploader/cos');
var qiniu = require('./uploader/qiniu');
var s3 = require('./uploader/s3');
var AVError = require('./error');
var AVRequest = require('./request').request;
var Promise = require('./promise');

module.exports = function (AV) {

  // 挂载一些配置
  var avConfig = AV._config;

  var hexOctet = function hexOctet() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  };

  // port from browserify path module
  // since react-native packager won't shim node modules.
  var extname = function extname(path) {
    return path.match(/^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/)[4];
  };

  var b64Digit = function b64Digit(number) {
    if (number < 26) {
      return String.fromCharCode(65 + number);
    }
    if (number < 52) {
      return String.fromCharCode(97 + (number - 26));
    }
    if (number < 62) {
      return String.fromCharCode(48 + (number - 52));
    }
    if (number === 62) {
      return '+';
    }
    if (number === 63) {
      return '/';
    }
    throw new Error('Tried to encode large digit ' + number + ' in base64.');
  };

  var encodeBase64 = function encodeBase64(array) {
    var chunks = [];
    chunks.length = Math.ceil(array.length / 3);
    _.times(chunks.length, function (i) {
      var b1 = array[i * 3];
      var b2 = array[i * 3 + 1] || 0;
      var b3 = array[i * 3 + 2] || 0;

      var has2 = i * 3 + 1 < array.length;
      var has3 = i * 3 + 2 < array.length;

      chunks[i] = [b64Digit(b1 >> 2 & 0x3F), b64Digit(b1 << 4 & 0x30 | b2 >> 4 & 0x0F), has2 ? b64Digit(b2 << 2 & 0x3C | b3 >> 6 & 0x03) : "=", has3 ? b64Digit(b3 & 0x3F) : "="].join("");
    });
    return chunks.join("");
  };

  /**
   * An AV.File is a local representation of a file that is saved to the AV
   * cloud.
   * @param name {String} The file's name. This will change to a unique value
   *     once the file has finished saving.
   * @param data {Array} The data for the file, as either:
   *     1. an Array of byte value Numbers, or
   *     2. an Object like { base64: "..." } with a base64-encoded String.
   *     3. a File object selected with a file upload control. (3) only works
   *        in Firefox 3.6+, Safari 6.0.2+, Chrome 7+, and IE 10+.
   *     4.a Buffer object in Node.js runtime.
   *
   *        For example:<pre>
   * var fileUploadControl = $("#profilePhotoFileUpload")[0];
   * if (fileUploadControl.files.length > 0) {
   *   var file = fileUploadControl.files[0];
   *   var name = "photo.jpg";
   *   var file = new AV.File(name, file);
   *   file.save().then(function() {
   *     // The file has been saved to AV.
   *   }, function(error) {
   *     // The file either could not be read, or could not be saved to AV.
   *   });
   * }</pre>
   *
   * @class
   * @param [mimeType] {String} Content-Type header to use for the file. If
   *     this is omitted, the content type will be inferred from the name's
   *     extension.
   */
  AV.File = function (name, data, mimeType) {

    this.attributes = {
      name: name,
      url: '',
      metaData: {},
      // 用来存储转换后要上传的 base64 String
      base64: ''
    };

    this._extName = '';

    var owner = void 0;
    if (data && data.owner) {
      owner = data.owner;
    } else if (!AV._config.disableCurrentUser) {
      try {
        owner = AV.User.current();
      } catch (error) {
        if ('SYNC_API_NOT_AVAILABLE' === error.code) {
          console.warn('Get current user failed. It seems this runtime use an async storage system, please create AV.File in the callback of AV.User.currentAsync().');
        } else {
          throw error;
        }
      }
    }

    this.attributes.metaData = {
      owner: owner ? owner.id : 'unknown'
    };

    this.set('mime_type', mimeType);

    if (_.isArray(data)) {
      this.attributes.metaData.size = data.length;
      data = { base64: encodeBase64(data) };
    }
    if (data && data.base64) {
      var parseBase64 = require('./utils/parse-base64');
      var dataBase64 = parseBase64(data.base64, mimeType);
      this._source = Promise.resolve({ data: dataBase64, type: mimeType });
    } else if (data && data.blob) {
      if (!data.blob.type && mimeType) {
        data.blob.type = mimeType;
      }
      if (!data.blob.name) {
        data.blob.name = name;
      }
      if (process.env.CLIENT_PLATFORM === 'ReactNative' || process.env.CLIENT_PLATFORM === 'Weapp') {
        this._extName = extname(data.blob.uri);
      }
      this._source = Promise.resolve({ data: data.blob, type: mimeType });
    } else if (typeof File !== "undefined" && data instanceof File) {
      if (data.size) {
        this.attributes.metaData.size = data.size;
      }
      if (data.name) {
        this._extName = extname(data.name);
      }
      this._source = Promise.resolve({ data: data, type: mimeType });
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      this.attributes.metaData.size = data.length;
      this._source = Promise.resolve({ data: data, type: mimeType });
    } else if (_.isString(data)) {
      throw new Error("Creating a AV.File from a String is not yet supported.");
    }
  };

  /**
   * Creates a fresh AV.File object with exists url for saving to AVOS Cloud.
   * @param {String} name the file name
   * @param {String} url the file url.
   * @param {Object} [metaData] the file metadata object.
   * @param {String} [type] Content-Type header to use for the file. If
   *     this is omitted, the content type will be inferred from the name's
   *     extension.
   * @return {AV.File} the file object
   */
  AV.File.withURL = function (name, url, metaData, type) {
    if (!name || !url) {
      throw new Error("Please provide file name and url");
    }
    var file = new AV.File(name, null, type);
    //copy metaData properties to file.
    if (metaData) {
      for (var prop in metaData) {
        if (!file.attributes.metaData[prop]) file.attributes.metaData[prop] = metaData[prop];
      }
    }
    file.attributes.url = url;
    //Mark the file is from external source.
    file.attributes.metaData.__source = 'external';
    return file;
  };

  /**
   * Creates a file object with exists objectId.
   * @param {String} objectId The objectId string
   * @return {AV.File} the file object
   */
  AV.File.createWithoutData = function (objectId) {
    var file = new AV.File();
    file.id = objectId;
    return file;
  };

  AV.File.prototype = {
    className: '_File',

    toJSON: function toJSON() {
      return AV._encode(this);
    },

    /**
     * Returns the ACL for this file.
     * @returns {AV.ACL} An instance of AV.ACL.
     */
    getACL: function getACL() {
      return this._acl;
    },

    /**
     * Sets the ACL to be used for this file.
     * @param {AV.ACL} acl An instance of AV.ACL.
     */
    setACL: function setACL(acl) {
      if (!(acl instanceof AV.ACL)) {
        return new AVError(AVError.OTHER_CAUSE, 'ACL must be a AV.ACL.');
      }
      this._acl = acl;
    },

    /**
     * Gets the name of the file. Before save is called, this is the filename
     * given by the user. After save is called, that name gets prefixed with a
     * unique identifier.
     */
    name: function name() {
      return this.get('name');
    },

    /**
     * Gets the url of the file. It is only available after you save the file or
     * after you get the file from a AV.Object.
     * @return {String}
     */
    url: function url() {
      return this.get('url');
    },

    /**
    * Gets the attributs of the file object.
    * @param {String} The attribute name which want to get.
    * @returns {Any}
    */
    get: function get(attrName) {
      switch (attrName) {
        case 'objectId':
          return this.id;
        case 'url':
        case 'name':
        case 'mime_type':
        case 'metaData':
        case 'createdAt':
        case 'updatedAt':
          return this.attributes[attrName];
        default:
          return this.attributes.metaData[attrName];
      }
    },

    /**
    * Set the metaData of the file object.
    * @param {Object} Object is an key value Object for setting metaData.
    * @param {String} attr is an optional metadata key.
    * @param {Object} value is an optional metadata value.
    * @returns {String|Number|Array|Object}
    */
    set: function set() {
      var _this = this;

      var set = function set(attrName, value) {
        switch (attrName) {
          case 'name':
          case 'url':
          case 'mime_type':
          case 'base64':
          case 'metaData':
            _this.attributes[attrName] = value;
            break;
          default:
            // File 并非一个 AVObject，不能完全自定义其他属性，所以只能都放在 metaData 上面
            _this.attributes.metaData[attrName] = value;
            break;
        }
      };

      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      switch (args.length) {
        case 1:
          // 传入一个 Object
          for (var k in args[0]) {
            set(k, args[0][k]);
          }
          break;
        case 2:
          set(args[0], args[1]);
          break;
      }
    },

    /**
    * <p>Returns the file's metadata JSON object if no arguments is given.Returns the
    * metadata value if a key is given.Set metadata value if key and value are both given.</p>
    * <p><pre>
    *  var metadata = file.metaData(); //Get metadata JSON object.
    *  var size = file.metaData('size');  // Get the size metadata value.
    *  file.metaData('format', 'jpeg'); //set metadata attribute and value.
    *</pre></p>
    * @return {Object} The file's metadata JSON object.
    * @param {String} attr an optional metadata key.
    * @param {Object} value an optional metadata value.
    **/
    metaData: function metaData(attr, value) {
      if (attr && value) {
        this.attributes.metaData[attr] = value;
        return this;
      } else if (attr && !value) {
        return this.attributes.metaData[attr];
      } else {
        return this.attributes.metaData;
      }
    },

    /**
     * 如果文件是图片，获取图片的缩略图URL。可以传入宽度、高度、质量、格式等参数。
     * @return {String} 缩略图URL
     * @param {Number} width 宽度，单位：像素
     * @param {Number} heigth 高度，单位：像素
     * @param {Number} quality 质量，1-100的数字，默认100
     * @param {Number} scaleToFit 是否将图片自适应大小。默认为true。
     * @param {String} fmt 格式，默认为png，也可以为jpeg,gif等格式。
     */

    thumbnailURL: function thumbnailURL(width, height, quality, scaleToFit, fmt) {
      var url = this.attributes.url;
      if (!url) {
        throw new Error('Invalid url.');
      }
      if (!width || !height || width <= 0 || height <= 0) {
        throw new Error('Invalid width or height value.');
      }
      quality = quality || 100;
      scaleToFit = !scaleToFit ? true : scaleToFit;
      if (quality <= 0 || quality > 100) {
        throw new Error('Invalid quality value.');
      }
      fmt = fmt || 'png';
      var mode = scaleToFit ? 2 : 1;
      return url + '?imageView/' + mode + '/w/' + width + '/h/' + height + '/q/' + quality + '/format/' + fmt;
    },

    /**
    * Returns the file's size.
    * @return {Number} The file's size in bytes.
    **/
    size: function size() {
      return this.metaData().size;
    },

    /**
     * Returns the file's owner.
     * @return {String} The file's owner id.
     */
    ownerId: function ownerId() {
      return this.metaData().owner;
    },

    /**
    * Destroy the file.
    * @param {AuthOptions} options
    * @return {Promise} A promise that is fulfilled when the destroy
    *     completes.
    */
    destroy: function destroy(options) {
      if (!this.id) {
        return Promise.reject(new Error('The file id is not eixsts.'));
      }
      var request = AVRequest("files", null, this.id, 'DELETE', null, options);
      return request;
    },

    /**
     * Request Qiniu upload token
     * @param {string} type
     * @return {Promise} Resolved with the response
     * @private
     */
    _fileToken: function _fileToken(type) {
      var _this2 = this;

      var route = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'fileTokens';

      var name = this.attributes.name;

      // Create 16-bits uuid as qiniu key.
      var extName = extname(name) || this._extName;
      var key = hexOctet() + hexOctet() + hexOctet() + hexOctet() + hexOctet() + extName;
      var data = {
        key: key,
        name: name,
        ACL: this._acl,
        mime_type: type,
        metaData: this.attributes.metaData
      };
      this._qiniu_key = key;
      return AVRequest(route, null, null, 'POST', data).then(function (response) {
        if (response.mime_type) {
          _this2.set('mime_type', response.mime_type);
        }
        return response;
      });
    },


    /**
     * @callback UploadProgressCallback
     * @param {XMLHttpRequestProgressEvent} event - The progress event with 'loaded' and 'total' attributes
     */
    /**
     * Saves the file to the AV cloud.
     * @param {Object} [options]
     * @param {UploadProgressCallback} [options.onprogress] 文件上传进度，在 Node.js 与小程序中无效，回调参数说明详见 {@link UploadProgressCallback}。
     * @return {Promise} Promise that is resolved when the save finishes.
     */
    save: function save(options) {
      var _this3 = this;

      if (this.id) {
        throw new Error('File already saved. If you want to manipulate a file, use AV.Query to get it.');
      }
      if (!this._previousSave) {
        if (this._source) {
          this._previousSave = this._source.then(function (_ref) {
            var data = _ref.data,
                type = _ref.type;
            return _this3._fileToken(type).then(function (uploadInfo) {
              var uploadPromise = void 0;
              switch (uploadInfo.provider) {
                case 's3':
                  uploadPromise = s3(uploadInfo, data, _this3, options);
                  break;
                case 'qcloud':
                  uploadPromise = cos(uploadInfo, data, _this3, options);
                  break;
                case 'qiniu':
                default:
                  uploadPromise = qiniu(uploadInfo, data, _this3, options);
                  break;
              }
              return uploadPromise.catch(function (err) {
                // destroy this file object when upload fails.
                _this3.destroy();
                throw err;
              });
            });
          });
        } else if (this.attributes.url && this.attributes.metaData.__source === 'external') {
          // external link file.
          var data = {
            name: this.attributes.name,
            ACL: this._acl,
            metaData: this.attributes.metaData,
            mime_type: this.mimeType,
            url: this.attributes.url
          };
          this._previousSave = AVRequest('files', this.attributes.name, null, 'post', data).then(function (response) {
            _this3.attributes.name = response.name;
            _this3.attributes.url = response.url;
            _this3.id = response.objectId;
            if (response.size) {
              _this3.attributes.metaData.size = response.size;
            }
            return _this3;
          });
        }
      }
      return this._previousSave;
    },

    /**
    * fetch the file from server. If the server's representation of the
    * model differs from its current attributes, they will be overriden,
    * @param {AuthOptions} options AuthOptions plus 'keys' and 'include' option.
    * @return {Promise} A promise that is fulfilled when the fetch
    *     completes.
    */
    fetch: function fetch(options) {
      var options = null;

      var request = AVRequest('files', null, this.id, 'GET', options);
      return request.then(this._finishFetch.bind(this));
    },
    _finishFetch: function _finishFetch(response) {
      var value = AV.Object.prototype.parse(response);
      value.attributes = {
        name: value.name,
        url: value.url,
        mime_type: value.mime_type
      };
      value.attributes.metaData = value.metaData || {};
      value.id = value.objectId;
      // clean
      delete value.objectId;
      delete value.metaData;
      delete value.url;
      delete value.name;
      delete value.mime_type;
      _.extend(this, value);
      return this;
    }
  };
};