const axios = require('axios');

/**
 * Makes an HTTP Call using Axios.
 *
 * @param {string} method - The HTTP method (e.g., 'get', 'post', 'put', 'delete').
 * @param {string} url - The URL to send the HTTP request to.
 * @param {object|null} data - The data to send with the request (optional, used for POST/PUT requests).
 * @param {object} headers - The HTTP headers to include in the request (optional).
 *
 * @returns {Promise<any>} A Promise that resolves with the response when the request is successful.
 * @throws {Error} If an error occurs during the request.
 */

async function makeHttpCall(method, url, data = null, headers = {}) {
  try {
    const axiosConfig = {
      method,
      url,
      headers,
    };

    // Only attach a request body when one is actually provided. Sending
    // `data: null` on a GET makes axios serialize a literal "null" body,
    // which Kore's getMessages endpoint rejects as "Malformed JSON".
    if (data !== null && data !== undefined) {
      axiosConfig.data = data;
    }

    const response = await axios(axiosConfig);

    return response;
  } catch (error) {
    throw error;
  }
}


module.exports = {
    makeHttpCall
}