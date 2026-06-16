/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Utility Class
 * 
 * This file provides utility functions used throughout the UTXO tracker
 *
 ********************************************************************/

// Load required libraries
const crypto = require('crypto');
const { hrtime } = require('node:process');

var debugTime = {}

//For debugging
const NS_PER_SEC = 1e9;

module.exports = {

    // Handle sleeping for a given number of milliseconds
    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Throw an error and log to console
    throwError: function(error){
        console.error('throwError:', error);
        throw error;
    },

    // Get a SHA256 hash of a given data object
    getDataHash: function(data){
        let obj  = Object.assign({}, data); // Convert data to object if not already
        let json = JSON.stringify(obj);     // Convert object to JSON string
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    },
    markTime: function(timeName){
        debugTime[timeName] = hrtime()
    },
    addTime: function(timeName){
        let label = timeName+"**TOTAL"
        let labelCount = timeName+"**COUNT"
        let diffTime = hrtime(debugTime[timeName])
        
        if (!(label in debugTime)){
            debugTime[label] = [0,0]
            debugTime[labelCount] = 0
        }
        
        debugTime[label] = [debugTime[label][0] + diffTime[0],debugTime[label][1] + diffTime[1]]
    },
    logTotalTime: function(timeName){
        if (timeName+"**TOTAL" in debugTime){
            let diffTime = debugTime[timeName+"**TOTAL"]
            console.log("Time('"+timeName+"'): "+(diffTime[0] * NS_PER_SEC + diffTime[1])+" ns. It was called "+debugTime[timeName+"**COUNT"]+" times");
            debugTime[timeName+"**TOTAL"] = [0,0]
            debugTime[timeName+"**COUNT"] = 0
            delete debugTime[timeName+"**TOTAL"]
            delete debugTime[timeName+"**COUNT"]
        }
    },
    logTime: function(timeName){
        let diffTime = hrtime(debugTime[timeName])
        console.log("Time('"+timeName+"'): "+(diffTime[0] * NS_PER_SEC + diffTime[1])+" ns");
    },
    // Start a debug timer
    startTimer: function(){
        let now = Date.now();
        return now;
    },

    // Log a timer using a given name
    logTimer: function(timer, timeName){
        let now = Date.now();
        let ms  = now - timer;
        var timeString = this.millisecondsToTimeString(ms);
        var niceString = (timeName!=null) ? timeName : 'Time';
        niceString += "\t: " + ms + 'ms';
        if(timeString!='')
            niceString += ' (' + timeString + ')';
        console.log(niceString);
    },

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString: function(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    },
    
    uint8ArrayToHex: function(uint8array){
        let hex = '';
        for (let i = 0; i < uint8array.length; i++) {
            const byte = uint8array[i];
            hex += byte.toString(16).padStart(2, '0');
        }
        return hex;
    }
}