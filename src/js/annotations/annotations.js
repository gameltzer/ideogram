/**
 * @fileoverview Methods for ideogram annotations.
 * Annotations are graphical objects that represent features of interest
 * located on the chromosomes, e.g. genes or variations.  They can
 * appear beside a chromosome, overlaid on top of it, or between multiple
 * chromosomes.
 */

import * as d3selection from 'd3-selection';
import * as d3fetch from 'd3-fetch';

import {BedParser} from '../parsers/bed-parser';
import {Object} from '../lib.js';
import {
  drawHeatmaps, deserializeAnnotsForHeatmap
} from './heatmap';
import {
  onLoadAnnots, onDrawAnnots, startHideAnnotTooltipTimeout,
  onWillShowAnnotTooltip, showAnnotTooltip
} from './events';
import {drawAnnots, drawProcessedAnnots} from './draw';
import {getHistogramBars} from './histogram';
import {drawSynteny} from './synteny';

var d3 = Object.assign({}, d3selection, d3fetch);

/**
 * Proccesses genome annotation data.
 * Genome annotations represent features like a gene, SNP, etc. as
 * a small graphical object on or beside a chromosome.
 * Converts raw annotation data from server, which is structured as
 * an array of arrays, into a more verbose data structure consisting
 * of an array of objects.
 * Also adds pixel offset information.
 */
function processAnnotData(rawAnnots) {
  var keys, i, j, k, m, annot, annots, annotsByChr, chr, chrModel, ra,
    startPx, stopPx, px, annotTrack, color, shape,
    ideo = this;

  keys = rawAnnots.keys;
  rawAnnots = rawAnnots.annots;

  annots = [];

  m = -1;
  for (i = 0; i < rawAnnots.length; i++) {

    annotsByChr = rawAnnots[i];

    chr = annotsByChr.chr;
    chrModel = ideo.chromosomes[ideo.config.taxid][chr];

    if (typeof chrModel === 'undefined') {
      console.warn(
        'Chromosome "' + chr + '" undefined in ideogram; ' +
        annotsByChr.annots.length + ' annotations not shown'
      );
      continue;
    }

    m++;
    annots.push({chr: annotsByChr.chr, annots: []});

    for (j = 0; j < annotsByChr.annots.length; j++) {
      ra = annotsByChr.annots[j];
      annot = {};

      for (k = 0; k < keys.length; k++) {
        annot[keys[k]] = ra[k];
      }

      annot.stop = annot.start + annot.length;

      startPx = ideo.convertBpToPx(chrModel, annot.start);
      stopPx = ideo.convertBpToPx(chrModel, annot.stop);

      px = Math.round((startPx + stopPx) / 2);

      color = ideo.config.annotationsColor;
      if (ideo.config.annotationTracks) {
        annot.trackIndex = ra[3];
        annotTrack = ideo.config.annotationTracks[annot.trackIndex];
        color = annotTrack.color;
        shape = annotTrack.shape;
      } else {
        annot.trackIndex = 0;
      }

      if ('color' in annot) {
        color = annot.color;
      }

      if ('shape' in annot) {
        shape = annot.shape;
      }

      annot.chr = chr;
      annot.chrIndex = i;
      annot.px = px;
      annot.startPx = startPx;
      annot.stopPx = stopPx;
      annot.color = color;
      annot.shape = shape;

      annots[m].annots.push(annot);
    }
  }

  return annots;
}

/**
 * Initializes various annotation settings.  Constructor help function.
 */
function initAnnotSettings() {
  if (
    this.config.annotationsPath ||
    this.config.localAnnotationsPath ||
    this.annots || this.config.annotations
  ) {
    if (!this.config.annotationHeight) {
      var annotHeight = Math.round(this.config.chrHeight / 100);
      this.config.annotationHeight = annotHeight;
    }

    if (this.config.annotationTracks) {
      this.config.numAnnotTracks = this.config.annotationTracks.length;
    } else {
      this.config.numAnnotTracks = 1;
    }
    this.config.annotTracksHeight =
      this.config.annotationHeight * this.config.numAnnotTracks;

    if (typeof this.config.barWidth === 'undefined') {
      this.config.barWidth = 3;
    }
  } else {
    this.config.annotTracksHeight = 0;
  }

  if (typeof this.config.annotationsColor === 'undefined') {
    this.config.annotationsColor = '#F00';
  }

  if (this.config.showAnnotTooltip !== false) {
    this.config.showAnnotTooltip = true;
  }

  if (this.config.onWillShowAnnotTooltip) {
    this.onWillShowAnnotTooltipCallback = this.config.onWillShowAnnotTooltip;
  }
}

/**
 * Requests annotations URL via HTTP, sets ideo.rawAnnots for downstream
 * processing.
 *
 * @param annotsUrl Absolute or relative URL native or BED annotations file
 */
function fetchAnnots(annotsUrl) {

  var tmp, extension,
    ideo = this;

  function afterRawAnnots(rawAnnots) {
    if (ideo.config.heatmaps) {
      ideo.deserializeAnnotsForHeatmap(rawAnnots);
    }
    if (ideo.onLoadAnnotsCallback) {
      ideo.onLoadAnnotsCallback();
    }
  }

  if (annotsUrl.slice(0, 4) !== 'http') {
    d3.json(ideo.config.annotationsPath)
      .then(function(data) {
        ideo.rawAnnots = data;
        afterRawAnnots(ideo.rawAnnots);
      });
    return;
  }

  tmp = annotsUrl.split('?')[0].split('.');
  extension = tmp[tmp.length - 1];

  if (extension !== 'bed' && extension !== 'json') {
    extension = extension.toUpperCase();
    alert(
      'This Ideogram.js only supports BED and Ideogram JSON at the ' +
      'moment.  Sorry, check back soon for ' + extension + ' support!'
    );
    return;
  }

  d3.text(annotsUrl).then(function(text) {
    if (extension === 'bed') {
      ideo.rawAnnots = new BedParser(text, ideo).rawAnnots;
    } else {
      ideo.rawAnnots = JSON.parse(text);
    }
    afterRawAnnots(ideo.rawAnnots);
  });

}

/**
 * Fills out annotations data structure such that its top-level list of arrays
 * matches that of this ideogram's chromosomes list in order and number
 * Fixes https://github.com/eweitz/ideogram/issues/66
 */
function fillAnnots(annots) {
  var filledAnnots, chrs, chrArray, i, chr, annot, chrIndex;

  filledAnnots = [];
  chrs = [];
  chrArray = this.chromosomesArray;

  for (i = 0; i < chrArray.length; i++) {
    chr = chrArray[i].name;
    chrs.push(chr);
    filledAnnots.push({chr: chr, annots: []});
  }

  for (i = 0; i < annots.length; i++) {
    annot = annots[i];
    chrIndex = chrs.indexOf(annot.chr);
    if (chrIndex !== -1) {
      filledAnnots[chrIndex] = annot;
    }
  }

  return filledAnnots;
}

export {
  onLoadAnnots, onDrawAnnots, processAnnotData, initAnnotSettings,
  fetchAnnots, drawAnnots, getHistogramBars, drawHeatmaps,
  deserializeAnnotsForHeatmap, fillAnnots, drawProcessedAnnots, drawSynteny,
  startHideAnnotTooltipTimeout, showAnnotTooltip, onWillShowAnnotTooltip
}
