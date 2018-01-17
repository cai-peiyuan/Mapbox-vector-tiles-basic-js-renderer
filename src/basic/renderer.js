const BasicPainter = require('./painter'),
      BasicStyle = require('./style'),
      EXTENT = require('../data/extent'),
      Evented = require('../util/evented'),
      {OverscaledTileID} = require('../source/tile_id'),
      {mat4} = require('@mapbox/gl-matrix'),
      Source = require('../source/source'),
      QueryFeatures = require('../source/query_features'),
      EvaluationParameters = require('../style/evaluation_parameters'),
      Placement = require('../symbol/placement'),
      assert = require('assert');

const DEFAULT_RESOLUTION = 256;
const TILE_LOAD_TIMEOUT = 60000;
const OFFSCREEN_CANV_SIZE = 1024; 

class MapboxBasicRenderer extends Evented {

  constructor(options) {
    super();
    this._canvas = document.createElement('canvas');
    this._canvas.style.imageRendering = 'pixelated';
    this._canvas.addEventListener('webglcontextlost', () => console.log("webglcontextlost"), false);
    this._canvas.addEventListener('webglcontextrestored', () => this._createGlContext(), false); 
    this._canvas.width = OFFSCREEN_CANV_SIZE;
    this._canvas.height = OFFSCREEN_CANV_SIZE;
    this.transform = {
      zoom: 0,
      angle: 0,
      pitch: 0,
      _pitch: 0,
      scaleZoom: ()=> 0,
      cameraToCenterDistance: 1,
      cameraToTileDistance: () => 1,
      clone: () => this.transform,
      width: OFFSCREEN_CANV_SIZE,
      height: OFFSCREEN_CANV_SIZE,
      pixelsToGLUnits: [2 / OFFSCREEN_CANV_SIZE, -2 / OFFSCREEN_CANV_SIZE],
      tileZoom: tile => tile.tileID.canonical.z,
      calculatePosMatrix: tileID => tileID.posMatrix 
    };
    this._style = new BasicStyle(Object.assign({}, options.style, {transition: {duration: 0}}), this);
    this._style.setEventedParent(this, {style: this._style});
    this._style.on('data', e => (e.dataType === "style") && this._onReady());
    this._createGlContext();
    this.painter.resize(OFFSCREEN_CANV_SIZE, OFFSCREEN_CANV_SIZE); 
    this._pendingRenders = new Map(); // tileSetID => render state
    this._nextRenderId = 0; // each new render state created has a unique renderId in addition to its tileSetID, which isn't unique
    this._configId = 0; // for use with async config changes..see setXYZ methods below
  }

  _onReady(){
    this._style.update(new EvaluationParameters(16));
  }

  _transformRequest(url, resourceType) {
    return {url: url, headers: {}, credentials: ''};
  }

  _calculatePosMatrix(transX, transY, tileSize) {   
    /*
      The returned matrix, M, is designed to be used as:
        X_gl_coords = M * X_mvt_data_coords
      where X_gl_coords are in the range [-1,1]
      and X_mvt_data_coords are in the range [0,Extent], or rather they are nearly 
      within that range, they actually go outside it by about 10% to let polygons/lines
      span across tile boundaries.
      The translate/scale functions here could probably be ditched in favour of
      the mat4 versions, but I found it easier to do the multiplies myself.
    */
    var translate = (a, v) => {
      this._tmpMat4f64b = this._tmpMat4f64b || new Float32Array(16);
      mat4.identity(this._tmpMat4f64b);
      mat4.translate(this._tmpMat4f64b, this._tmpMat4f64b,v);
      mat4.multiply(a,this._tmpMat4f64b,a);
    }
    var scale = (a, v) => {
      this._tmpMat4f64b = this._tmpMat4f64b || new Float32Array(16);
      mat4.identity(this._tmpMat4f64b);
      mat4.scale(this._tmpMat4f64b, this._tmpMat4f64b,v);
      mat4.multiply(a,this._tmpMat4f64b,a);
    }

    this._tmpMat4f64 = this._tmpMat4f64 || new Float64Array(16); // reuse each time for GC's benefit
    this._tmpMat4f32 = new Float32Array(16); // TODO(optimization): may want to use a pool for this rather than a new one each time

    // The main calculation...
    mat4.identity(this._tmpMat4f64);
    let factor = tileSize/OFFSCREEN_CANV_SIZE;
    scale(this._tmpMat4f64,[2/EXTENT * factor, -2/EXTENT * factor, 1]);
    translate(this._tmpMat4f64, [-1 + 2*transX/OFFSCREEN_CANV_SIZE, 1 - 2*transY/OFFSCREEN_CANV_SIZE, 0]);

    this._tmpMat4f32.set(this._tmpMat4f64);
    return this._tmpMat4f32;
  }

  _createGlContext(){
    const attributes = Object.assign({
        failIfMajorPerformanceCaveat: false,
        preserveDrawingBuffer: false
    }, require('mapbox-gl-supported').webGLContextAttributes);
    
    this._gl = this._canvas.getContext('webgl', attributes) ||
               this._canvas.getContext('experimental-webgl', attributes);
    if (!this._gl) {
      throw new Error('Failed to initialize WebGL');
    }
    this.painter = new BasicPainter(this._gl, this.transform);
    this.painter.style = this._style;
  }

  setPaintProperty(layer, prop, val){
    this._cancelAllPendingRenders();
    let configId = ++this._configId;
    return this._style.setPaintProperty(layer, prop, val)
      .then(() => {
        this._style.update(new EvaluationParameters(16));
        return () => this._configId === configId;
      });
  }

  setFilter(layer, filter){
    // https://www.mapbox.com/mapbox-gl-js/style-spec/#types-filter
    this._cancelAllPendingRenders();
    let configId = ++this._configId;
    return this._style.setFilter(layer, filter)
      .then(() => {
        this._style.update(new EvaluationParameters(16));
        return () => this._configId === configId;
      });
  }
 
  // takes an array of layer names to show
  setLayers(visibleLayers){
    this._cancelAllPendingRenders();
    let configId = ++this._configId;
    return this._style.setLayers(visibleLayers)
      .then(() => {
        this._style.update(new EvaluationParameters(16));
        return () => this._configId === configId;
      });
  }

  getLayersVisible(zoom, source){
    // if zoom is provided will filter by min/max zoom as well as by layer visibility
    // and if source (string) is provided only style layers from that source will be returned.
    let layerStylesheetFromLayer = layer => 
      layer && layer._eventedParent.stylesheet.layers.find(x=>x.id===layer.id);

    return Object.keys(this._style._layers)
      .filter(lyr=>this._style.getLayoutProperty(lyr, 'visibility') === 'visible')
      .filter(lyr => {
        let layerStylesheet = layerStylesheetFromLayer(this._style._layers[lyr]);
        return (
          !zoom || (layerStylesheet         && 
           zoom >= layerStylesheet.minzoom_ &&
           zoom <= layerStylesheet.maxzoom_)   
        ) && (
          !source || (layerStylesheet       &&
          layerStylesheet.source === source)
        );
      });
  }

  filterForZoom(zoom){
    if(zoom === this.painter._filterForZoom){
      return;
    }
    this.painter._filterForZoom = zoom;
    this._cancelAllPendingRenders();
    return ++this._configId;
  }

  _cancelAllPendingRenders(){ 
    this._pendingRenders.forEach(s => this._finishRender(s.tileSetID, s.renderId, "canceled"));
    this._pendingRenders.clear();
    Object.values(this._style.sourceCaches).forEach(s => s.invalidateAllLoadedTiles());
  }

  _finishRender(tileSetID, renderId, err){ 
    let state = this._pendingRenders.get(tileSetID);
    if(!state || state.renderId !== renderId){
      return; // render for this tile has been canceled, or superceded.
    }
    while(state.consumers.length){
      state.consumers.shift().next(err);
    }
    clearTimeout(state.timeout);
    this._pendingRenders.delete(tileSetID);
    
    err && state.tiles.forEach(t => t.cache.releaseTile(t)); 
    // if the render is successful, then the responsibility for calling releaseRender lies elsewhere
  }

  _canonicalizeSpec(tilesSpec, drawSpec){
    // we define the origin as the minimum left and top values mentioned in tileSpec/drawSpec
    // and adjust all the top/left values to use this reference.  This cannonicalization means
    // we can spot tile sets that are the same except for a gobal translation.

    let minLeft = tilesSpec.map(s=>s.left).reduce((a,b)=>Math.min(a,b),Infinity);
    let minTop = tilesSpec.map(s=>s.top).reduce((a,b)=>Math.min(a,b), Infinity);
    //minLeft = Math.min(minLeft, drawSpec.srcLeft);
    //minTop = Math.min(minTop, drawSpec.srcTop);
    
    return {
      tilesSpec: tilesSpec.map(s => ({
        source: s.source,
        z: s.z,
        x: s.x,
        y: s.y,
        top: s.top - minTop,
        left: s.left - minLeft,
        size: s.size
      })),
      drawSpec: {
        srcLeft: drawSpec.srcLeft - minLeft,
        srcTop: drawSpec.srcTop - minTop,
        width: drawSpec.width,
        height: drawSpec.height,
        destLeft: drawSpec.destLeft,
        destTop: drawSpec.destTop,
        clear: drawSpec.clear
      }
    }
  }

  _tileSpecToString(tilesSpec){
    // this is basically a stable JSON.stringify..could proably optimize this a bit if we really cared.
    return tilesSpec
      .map(s => `${s.source} ${s.z} ${s.x} ${s.y} ${s.left} ${s.top} ${s.size}`)
      .sort()
      .join(" ");
  }



  releaseRender(renderRef){
    // call this when the rendered thing is no longer on screen (it could happen long after the render finishes, or before it finishes).
     
    let state = this._pendingRenders.get(renderRef.tileSetID);
    if(!state || state.renderId !== renderRef.renderId){
      return; // tile was already rendered
    } 
    
    renderRef.consumer.next("canceled");
    let idx = state.consumers.indexOf(renderRef.consumer);
    (idx !== -1) && state.consumers.splice(idx,1); 

    // if there are no consumers left then clean-up the render
    (state.consumers.length === 0) && this._finishRender(state.tileGroupID, renderRef.renderId, "fully-canceled");    
  }

  renderTiles(ctx, drawSpec, tilesSpec, next){
    // drawSpec has {destLeft,destTop,srcLeft,srcTop,width,height}
    // tilesSpec is an array of: {sourceName,z,x,y,left,top,size}
    // The tilesSpec defines how a selection of source tiles are rendered to an
    // imaginary canvas, and then drawSpec states what to copy from that imaginary canvas 
    // to the real ctx. 
    // the returned token must be passed to releaseRender at some point


    // need to filter sourceSpec based on which source layers we actually need with the current settings
    // note that each consumer adds an extra use++ to each source tile of relevance.

    // any requests that have the same tileSetID can be coallesced into a single _pendingRender
    ({drawSpec, tilesSpec} = this._canonicalizeSpec(tilesSpec, drawSpec));
    let tileSetID = this._tileSpecToString(tilesSpec);
    let consumer = {ctx, drawSpec, tilesSpec, next};

    // See if the tile set is already pending render, if so we don't need to do much...
    let state = this._pendingRenders.get(tileSetID);
    if(state){
      state.tiles.forEach(t => t.uses++);
      state.consumers.push(consumer);
      return {renderId: state.renderId, consumer, tiles: state.tiles};
    }

    // Ok, well we need to create a new pending render (which may include creating & loading new tiles)...
    let renderId = ++this._nextRenderId;
    state = {
      tileSetID,
      renderId, 
      tiles: tilesSpec.map(s => {
        let tileID = new OverscaledTileID(s.z, 0, s.z, s.x, s.y, 0);
        return this._style.sourceCaches[s.source].acquireTile(tileID, s.size); // includes .uses++
      }),
      consumers: [consumer],
      timeout: setTimeout(() => this._finishRender(tileSetID, renderId, "timeout"), TILE_LOAD_TIMEOUT) // might want to do this per-tile in the sourceCache
    };
    this._pendingRenders.set(tileSetID, state);

    // once all the tiles are loaded we can then execute the pending render...
    Promise.all(state.tiles.map(t => t.loadedPromise))
      // TODO: if one or more tiles is unavailable we could still carry on with the render I suppose, but need to release the bad tiles so we dont try and use them
      .catch(err => this._finishRender(tileSetID, renderId, err)) // will delete the pendingRender so the next promise's initial check will fail
      .then(() => {
        state = this._pendingRenders.get(tileSetID);
        if(!state || state.renderId !== renderId){
          return; // render for this tileGroupID has been canceled, or superceded.
        }

        // setup the list of currentlyRenderingTiles for each source
        Object.values(this._style.sourceCaches).forEach(c => c.currentlyRenderingTiles = []);
        tilesSpec.forEach((s,ii)=>{
          let t = state.tiles[ii];
          t.tileSize = s.size;
          t.left = s.left;
          t.top = s.top;
          this._style.sourceCaches[s.source].currentlyRenderingTiles.push(t);
        })

        // Work out the bounding box containing all src regions 
        let xSrcMin = state.consumers.map(c => c.drawSpec.srcLeft).reduce((a,b)=>Math.min(a,b),Infinity);
        let ySrcMin = state.consumers.map(c => c.drawSpec.srcTop).reduce((a,b)=>Math.min(a,b),Infinity);
        let xSrcMax = state.consumers.map(c => c.drawSpec.srcLeft + c.drawSpec.width).reduce((a,b)=>Math.max(a,b),-Infinity);
        let ySrcMax = state.consumers.map(c => c.drawSpec.srcTop + c.drawSpec.height).reduce((a,b)=>Math.max(a,b),-Infinity);

        // iterate over OFFSCREEN_CANV_SIZE x OFFSCREEN_CANV_SIZE blocks of that bounding box
        for(let xx=xSrcMin; xx<xSrcMax; xx+=OFFSCREEN_CANV_SIZE){
          for(let yy=ySrcMin; yy<ySrcMax; yy+=OFFSCREEN_CANV_SIZE){

            // for the section of the imaginary canvas at (xx,yy) and of
            // size OFFSCREEN_CANV_SIZE x OFFSCREEN_CANV_SIZE, find the list
            // of relevant consumers.
            let relevantConsumers = state.consumers.filter(c =>
              c.drawSpec.srcLeft + c.drawSpec.width > xx &&
              c.drawSpec.srcLeft < xx + OFFSCREEN_CANV_SIZE &&
              c.drawSpec.srcTop + c.drawSpec.height > yy && 
              c.drawSpec.srcTop < yy + OFFSCREEN_CANV_SIZE);
            if(relevantConsumers.length === 0){
              continue;
            }

            state.tiles.forEach(t => t.tileID.posMatrix = this._calculatePosMatrix(t.left-xx, t.top-yy, t.tileSize));
            this._style._updatePlacement(this.transform, false, 0); // not sure how often this needs to be done

            this.painter.render(this._style, {showTileBoundaries: false, showOverdrawInspector: false});

            relevantConsumers.forEach(c => {
              let srcLeft = Math.max(0, c.drawSpec.srcLeft-xx) | 0;
              let srcRight = Math.min(OFFSCREEN_CANV_SIZE, c.drawSpec.srcLeft + c.drawSpec.width - xx) | 0;
              let srcTop = Math.max(0, c.drawSpec.srcTop - yy) | 0;
              let srcBottom = Math.min(OFFSCREEN_CANV_SIZE, c.drawSpec.srcTop + c.drawSpec.height - yy) | 0;
              let destLeft = c.drawSpec.destLeft + (c.drawSpec.srcLeft<xx ? xx-c.drawSpec.srcLeft : 0);
              let destTop = c.drawSpec.destTop + (c.drawSpec.srcTop<yy ? yy-c.drawSpec.srcTop : 0);
              let width = srcRight-srcLeft;
              let height = srcBottom-srcTop;

              c.drawSpec.clear && c.ctx.clearRect(destLeft, destTop, width, height);
              c.ctx.drawImage(this._canvas, srcLeft, srcTop, width, height, destLeft, destTop, width, height);
            });
          } // yy
        } // xx
        
        while(state.consumers.length){
          state.consumers.shift().next();
        }
        clearTimeout(state.timeout);
        this._pendingRenders.delete(tileSetID);
        Object.values(this._style.sourceCaches).forEach(c => c.currentlyRenderingTiles = []);
      })

    return {renderId: state.renderId, consumer, tiles: state.tiles};
  }

  queryRenderedFeatures(opts){
    assert(opts.source);

    let layers = {};
    this.getLayersVisible(opts.renderedZoom, opts.source)
        .forEach(lyr => layers[lyr] = this._style._layers[lyr]);

    let featuresByRenderLayer = QueryFeatures.rendered(
      this._style.sourceCaches[opts.source],
      layers, 
      opts, 
      {}, opts.tileZ, 0);

    let featuresBySourceLayer = {};
    Object.keys(featuresByRenderLayer)
      .forEach(renderLayerName => 
        featuresByRenderLayer[renderLayerName].map(renderLayerFeatures => {
          let lyr = featuresBySourceLayer[renderLayerFeatures.layer['source-layer']]
                  = (featuresBySourceLayer[renderLayerFeatures.layer['source-layer']] || []);
          lyr.push(renderLayerFeatures._vectorTileFeature.properties)
        }));    
    return featuresBySourceLayer;
  }

  showCanvasForDebug(){
    document.body.appendChild(this._canvas);
    this._canvas.style.position = "fixed";
    this._canvas.style.bottom = "0px";
    this._canvas.style.right = "0px";
    this._canvas.style.background = "#ccc";
    this._canvas.style.opacity = '0.7';
    this._canvas.style.transform = 'scale(0.5) translate(502px,502px)'

  }
  destroyDebugCanvas(){
    renderer._canvas.parentElement && document.body.removeChild(this._canvas);
  }

}

module.exports =  MapboxBasicRenderer;