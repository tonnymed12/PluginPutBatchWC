sap.ui.define([
    'jquery.sap.global',
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "./Utils/Commons",
    "./Utils/ApiPaths",
    "../model/formatter",
    "sap/ui/core/Element",
    "sap/m/MessageBox"
], function (jQuery, PluginViewController, JSONModel, Commons, ApiPaths, formatter, Element, MessageBox) {
    "use strict";

    var gOperationPhase = {};
    const OPERATION_STATUS = { ACTIVE: "ACTIVE", QUEUED: "IN_QUEUE" }

    return PluginViewController.extend("serviacero.custom.plugins.zpluginPutBatchWC.zpluginPutBatchWC.controller.MainView", {
        Commons: Commons,
        ApiPaths: ApiPaths,
        formatter: formatter,

        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);
            this.oScanInput = this.byId("scanInput");
            this.iSecuenciaCounter = 0;  // Contador de secuencia para cada escaneo
            this.sAcActivity = "";       // Guardar valor AC_ACTIVITY del puesto
            this._oScanDebounceTimer = null;
            this._aBomNormalComponents = []; // Componentes NORMAL de la BOM para validación de lote

            // Modelo "orderSummary" 
            const oOrderSummaryModel = new JSONModel({
                lote: "",
                material: "",
                descripcion: "",
                cantidadNecesaria: 0,
                cantidadEscaneada: 0,
                cantidadConsumida: 0,
                cantidadConsumidaLotes: 0,
                cantidadEnProceso: 0,
                mostrarConsumos: false,
                scanHabilitado: true,
                unidadMedida: ""
            });
            this.getView().setModel(oOrderSummaryModel, "orderSummary");

            // Modelo de la tabla "Lotes consumidos"
            this.getView().setModel(new JSONModel({ ITEMS: [], total: 0, uom: "" }), "consumos");
            this._iConsumosReqId = 0;

            // Cola que serializa lectura+escritura de slots para evitar pisarse entre escaneos
            this._pWriteQueue = Promise.resolve();

        },
        onAfterRendering: function () {
            this._bAvisoInspeccionMostrado = false;
            this.onGetCustomValues();
            this.setOrderSummary();
        },

        onGetCustomValues: function () {
            const oView = this.getView(),
                oSapApi = this.getPublicApiRestDataSourceUri(),
                oTable = oView.byId("idSlotTable"),
                oPODParams = this.Commons.getPODParams(this.getOwnerComponent()),
                url = oSapApi + this.ApiPaths.OPERATION_ACTIVITIES,

                oParams = {
                    plant: oPODParams.PLANT_ID,
                    operation: oPODParams.OPERATION_ACTIVITY
                };

            this.ajaxGetRequest(url, oParams, function (oRes) {
                // content es un array paginado, tomamos el primer elemento
                var aContent = oRes.content || [];
                var oData = aContent[0];

                if (!oData || !oData.customValues) {
                    console.error("No se encontraron customValues en la respuesta");
                    return;
                }

                var aCustomValues = oData.customValues || [];

                this._actualizarCentroOperacion(oData);
                this._avisarOperacionInspeccion();

                // Lista dinámica: solo slots ocupados (sin pre-población por SLOTQTY)
                const aSlotsFixed = aCustomValues.filter(function (item) {
                    return item.attribute.startsWith("SLOT") &&
                        item.attribute !== "SLOTQTY" &&
                        item.attribute !== "SLOTTIPO" &&
                        item.value && item.value.trim() !== "";
                });

                aSlotsFixed.forEach(function (slot) {
                    slot.loteQty = slot.loteQty || "";
                    slot.loteUom = slot.loteUom || "";
                });

                // Setear los datos en la tabla
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsFixed }));
                this._updateOrderSummaryScannedQty(aSlotsFixed);
                this._avisarCantidadCubierta();

                // Setear los valores en los inputs
                const oSlotQtyInput = oView.byId("slotQty");
                if (oSlotQtyInput) {
                    oSlotQtyInput.setValue(aSlotsFixed.length.toString());
                }

                // Resetear o sincronizar secuencia
                const iSlotTotal = aSlotsFixed.filter(slot => slot.value && slot.value.trim() !== "").length;
                if (iSlotTotal === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    // Si hay slots, obtener el máximo número de secuencia para continuar desde ahí
                    const maxSecuencia = Math.max(...aSlotsFixed
                        .filter(slot => slot.value)
                        .map(slot => {
                            const parts = (slot.value || "").split('!');
                            return parseInt(parts[2] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

                // Al abrir/recargar, refrescar cantidades de los lotes escaneados
                this._refreshLoteQuantities(true);

            }.bind(this));
        },
        onBarcodeSubmit: function () {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            const sBarcode = oInput.getValue().trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (!sBarcode) {
                return; // no hacer nada si está vacío
            }

            if (this._bloquearEscaneoInspeccion()) {
                oInput.setValue("");
                return;
            }

            const oTable = oView.byId("idSlotTable");
            const oModel = oTable.getModel();
            const aItems = oModel.getProperty("/ITEMS") || [];

            const iSlotsConValor = aItems.filter(slot => slot.value && slot.value.trim() !== "").length;
            if (iSlotsConValor === 0) {
                this.iSecuenciaCounter = 0;
            }

            //comparacion del lote ingresado 
            const sNormalizado = sBarcode.toUpperCase();
            const partsBarcode = sNormalizado.split('!');

            if (partsBarcode.length < 2 || !partsBarcode[0] || !partsBarcode[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                oInput.setValue(""); oInput.focus();
                return;
            }
            const loteExtraido = partsBarcode[1].trim();
            const materialExtraido = partsBarcode[0].trim();

            // Verificar duplicado comparando solo material!lote (el valor almacenado incluye !SEQ)
            const sMaterialLoteEscaneado = materialExtraido + "!" + loteExtraido;
            const oExiste = aItems.find(function (Item) {
                var partsItem = (Item.value || "").toString().trim().toUpperCase().split('!');
                return partsItem.length >= 2 && partsItem.slice(0, 2).join('!') === sMaterialLoteEscaneado;
            });
            if (oExiste) {
                sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                oInput.setValue(""); oInput.focus();
                return;
            }

            this._validarMaterialYLote(loteExtraido, materialExtraido);

        },
        /**
         * Refresca las cantidades (loteQty) de todos los slots con valor,
         * consultando getReservas para cada lote escaneado. Solo lectura, no persiste nada.
         */
        onPressRefresh: function () {
            this._refreshLoteQuantities(false);
        },
        /**
         * @param {boolean} bSilent - true: sin mensajes (refresh automático al abrir)
         */
        _refreshLoteQuantities: function (bSilent) {
            var oView = this.getView();
            var oTable = oView.byId("idSlotTable");
            var oModel = oTable.getModel();
            var aItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var mandante = this.getConfiguration().mandante;
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var urlLote = oSapApi + this.ApiPaths.getReservas;

            // Filtrar solo slots con valor
            var aSlotsConValor = aItems.filter(function (slot) {
                return slot.value && slot.value.trim() !== "";
            });

            if (aSlotsConValor.length === 0) {
                if (!bSilent) {
                    sap.m.MessageToast.show(oBundle.getText("sinLotesParaRefrescar"));
                }
                return;
            }
            if (bSilent && !oPODParams.ORDER_ID) {
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            // Crear una promesa por cada slot para consultar su cantidad
            var aPromises = aSlotsConValor.map(function (slot) {
                var parts = slot.value.split('!');
                var sMaterial = (parts[0] || "").trim();
                var sLote = (parts[1] || "").trim();

                var inParams = {
                    "inPlanta": oPODParams.PLANT_ID,
                    "inLote": sLote,
                    "inOrden": oPODParams.ORDER_ID,
                    "inSapClient": mandante,
                    "inMaterial": sMaterial,
                    "inPuesto": oPODParams.WORK_CENTER
                };

                return new Promise(function (resolve) {
                    this.ajaxPostRequest(urlLote, inParams,
                        function (oRes) {
                            slot.loteQty = this._formatLoteQty(oRes.outCantidadLote);
                            slot.loteUom = oRes.outOUMLote || "";
                            resolve({ slot: slot, ok: true });
                        }.bind(this),
                        function () {
                            // Si falla un lote individual, no bloquear los demás
                            resolve({ slot: slot, ok: false });
                        }.bind(this)
                    );
                }.bind(this));
            }.bind(this));

            Promise.all(aPromises).then(function (aResults) {
                oView.byId("idPluginPanel").setBusy(false);
                // El modelo fue reemplazado por otra carga mientras se consultaba: descartar
                if (oTable.getModel() !== oModel) {
                    return;
                }
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aItems);

                if (bSilent) {
                    return;
                }
                var iFailed = aResults.filter(function (r) { return !r.ok; }).length;
                if (iFailed > 0) {
                    sap.m.MessageToast.show(oBundle.getText("refreshParcial", [iFailed]));
                } else {
                    sap.m.MessageToast.show(oBundle.getText("refreshExitoso"));
                }
            }.bind(this));
        },
        onPressClear: function () {
            const oView = this.getView(),
                oResBun = oView.getModel("i18n").getResourceBundle();
            this.Commons.showConfirmDialog(function () {
                this.clearModel();
            }.bind(this), null, oResBun.getText("clearWarningMessage"));
        },
        clearModel: function () {
            const oView = this.getView();
            const oTable = oView.byId("idSlotTable");
            const oScanInput = oView.byId("scanInput");
            const oModel = oTable.getModel();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            //obtener el modelo actual de la tabla 
            const aItems = oModel.getProperty("/ITEMS") || [];
            if (aItems.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }
            // Limpiar la tabla inmediatamente (lista dinámica: tabla vacía)
            oModel.setProperty("/ITEMS", []);
            oModel.refresh(true);
            this._updateOrderSummaryScannedQty([]);
            oScanInput.setValue("");
            oScanInput.focus();

            // Resetear secuencia cuando se limpian los datos
            this.iSecuenciaCounter = 0;

            //se prepara los datos para hacer el update 
            const aEdited = [
                ...aItems.map(slot => ({ attribute: slot.attribute, value: "" }))
            ]

            // Llama a la API para obtener los originales
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };
            //llamado a la API 
            this._enqueueWrite(() => this.getWorkCenterCustomValues(sParams, oSapApi).then(oOriginalRes => {
                const aOriginal = oOriginalRes.customValues || [];
                const aEditMap = {};

                //se crea el mapa de los valores editados (los vacioos)
                aEdited.forEach(item => {
                    aEditMap[item.attribute] = item.value;  //-----------------------------------------------------------------------------
                })
                //combinar los originales con los editados
                const aCustomValuesFinal = aOriginal.map(item => ({
                    attribute: item.attribute,
                    value: aEditMap.hasOwnProperty(item.attribute) ? aEditMap[item.attribute] : item.value
                }));
                // Agregar los que no estaban en el original, los nuevos en este caso los vacios 
                for (const key in aEditMap) {
                    if (!aCustomValuesFinal.find(i => i.attribute === key)) {
                        aCustomValuesFinal.push({ attribute: key, value: aEditMap[key] });
                    }
                }
                //llamar al pp para actualizar los customValues de WC
                return this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inOperationActivity: oOriginalRes.operationActivity
                }, oSapApi).then(() => {
                    sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
                    // sap.m.MessageToast.show("Lote actualizado correctamente");
                }).catch(() => {
                    sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                    // En caso de error, recargar los datos originales
                    this.onGetCustomValues();
                });
            }).catch(() => {
                sap.m.MessageToast.show(oBundle.getText("errorObtenerDatosOriginales"));
            }));

        },
        /**
        * Llamada al Pp(getReservas) para obtener los lotes en Reserva y hacer validacion de material
        * @param {string} sLote - Valor del lote "material!lote" 
        * @param {string} sMaterial - Valor del material "material!lote" 
        * @param {string} bAcActivityValidado - Valor de actividad
        * @param {boolean} bCubiertaConfirmada - true si el operador ya confirmó escanear con la orden cubierta
        * @returns {string} - Solo el material
        */
        _validarMaterialYLote: function (sLote, sMaterial, bAcActivityValidado, bCubiertaConfirmada) {
            const oView = this.getView();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const mandante = this.getConfiguration().mandante;
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oInput = oView.byId("scanInput");
            const loteEscaneado = sLote;
            const materialEscaneado = sMaterial;
            const puesto = oPODParams.WORK_CENTER;
            const sAcActivity = this.sAcActivity;  //customValue AC_ACTIVITY 
            const bEsPuestoCritico = ["TA01", "TA02", "SL02"].includes(puesto);

            // Validación de estatus de operación (en tiempo real desde POD)
            const sCurrentStatus = this._getCurrentOperationStatus();
            // if (sCurrentStatus !== OPERATION_STATUS.ACTIVE) {
            //     sap.m.MessageBox.error(oBundle.getText("verificarStatusOperacion"))
            //     return;
            // }

            // Orden ya cubierta (consumido + escaneado >= requerido): pedir confirmación antes de montar otro lote
            if (!bCubiertaConfirmada) {
                const oCubierta = this._getCantidadCubiertaInfo();
                if (oCubierta.bCubierta) {
                    MessageBox.warning(
                        oBundle.getText("cantidadOrdenCubiertaConfirmar", [oCubierta.nNecesaria, oCubierta.nTotal]),
                        {
                            actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                            emphasizedAction: MessageBox.Action.NO,
                            onClose: function (sAction) {
                                if (sAction === MessageBox.Action.YES) {
                                    this._validarMaterialYLote(loteEscaneado, materialEscaneado, bAcActivityValidado, true);
                                    return;
                                }
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                this._slotContext = null;
                            }.bind(this)
                        }
                    );
                    return;
                }
            }

            // validación de actividad (siempre refrescar en puestos críticos)
            if (bEsPuestoCritico && bAcActivityValidado !== true) {
                const oSapApi = this.getPublicApiRestDataSourceUri();
                const sParams = {
                    plant: oPODParams.PLANT_ID,
                    workCenter: oPODParams.WORK_CENTER
                };

                this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oWcData) {
                    const aCustomValues = (oWcData && oWcData.customValues) ? oWcData.customValues : [];
                    const oAcActivity = aCustomValues.find((element) => element.attribute == "AC_ACTIVITY");
                    const sAcActivityRefrescado = (((oAcActivity && oAcActivity.value) || "") + "").trim().toUpperCase();

                    this.sAcActivity = sAcActivityRefrescado;

                    // if (sAcActivityRefrescado !== "SETUP") {
                    //     sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                    //     return;
                    // }

                    this._validarMaterialYLote(loteEscaneado, materialEscaneado, true, bCubiertaConfirmada);
                }.bind(this));
                return;
            }

            // if (bEsPuestoCritico) {
            //     const sAcActivityNormalizado = ((sAcActivity || "") + "").trim().toUpperCase();
            //     if (sAcActivityNormalizado !== "SETUP") {
            //         sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
            //         return;
            //     }
            // }

            // validacion de material
            const oSapApi = this.getPublicApiRestDataSourceUri();

            // Validación frontend: el lote debe estar asignado en la BOM de la orden
            if (this._aBomNormalComponents && this._aBomNormalComponents.length > 0) {
                var bEnBOM = this._aBomNormalComponents.some(function (oComp) {
                    var sCompMat = (oComp.material && oComp.material.material)
                        ? oComp.material.material.toUpperCase() : "";
                    var sCompLote = (oComp.batchNumber || "").toUpperCase();
                    return sCompMat === materialEscaneado.toUpperCase()
                        && sCompLote === loteEscaneado.toUpperCase();
                });
                if (!bEnBOM) {
                    sap.m.MessageToast.show(oBundle.getText("loteNoEnBOM"));
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    this._slotContext = null;
                    return;
                }
            }

            const urlMaterial = oSapApi + this.ApiPaths.validateMaterialEnOrden;
            var inParamsMaterial = {
                "inPlanta": oPODParams.PLANT_ID,
                "inLote": loteEscaneado,
                "inOrden": oPODParams.ORDER_ID,
                "inMaterial": materialEscaneado
            };
            oView.byId("idPluginPanel").setBusy(true);

            this.ajaxPostRequest(urlMaterial, inParamsMaterial,
                // SUCCESS callback de validación de material
                function (oResMat) {
                    const matOk = oResMat && (oResMat.outMaterial === true || oResMat.outMaterial === "true");
                    const msgMat = (oResMat && oResMat.outMensaje) || oBundle.getText("materialNoValido");

                    if (!matOk) {
                        oView.byId("idPluginPanel").setBusy(false);
                        sap.m.MessageToast.show(msgMat);
                        if (!this._slotContext) {
                            oInput.setValue("");
                            oInput.focus();
                        }
                        this._slotContext = null;
                        return;
                    }

                    //Validacion de lotes  
                    var urlLote = oSapApi + this.ApiPaths.getReservas;
                    var inParamsLote = {
                        "inPlanta": oPODParams.PLANT_ID,
                        "inLote": loteEscaneado,
                        "inOrden": oPODParams.ORDER_ID,
                        "inSapClient": mandante,
                        "inMaterial": materialEscaneado,
                        "inPuesto": oPODParams.WORK_CENTER
                    };

                    this.ajaxPostRequest(urlLote, inParamsLote,
                        // SUCCESS callback de validación de lote
                        function (oResponseData) {
                            oView.byId("idPluginPanel").setBusy(false);

                            var bEsValido = false;
                            if (oResponseData.outLote === "true" || oResponseData.outLote === true) {
                                bEsValido = true;
                            } else if (oResponseData.outLote === "false" || oResponseData.outLote === false) {
                                bEsValido = false;
                            }

                            if (bEsValido) {
                                const sCantidadLote = this._formatLoteQty(oResponseData.outCantidadLote);
                                const sUomLote = oResponseData.outOUMLote || "";
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    // Pasar barcode capturado ANTES de la validación async para
                                    // evitar race condition si el input fue limpiado durante la espera.
                                    this._ejecutarUpdate(sCantidadLote, sUomLote, materialEscaneado + "!" + loteEscaneado);
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._slotContext.loteQty = sCantidadLote;
                                    this._slotContext.uom = sUomLote;
                                    this._procesarSlotValidado(sCantidadLote, sUomLote);
                                }
                            } else {
                                sap.m.MessageToast.show(oBundle.getText("loteNoValido"));
                                // Solo limpiar input si viene del input superior
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                // Limpiar contexto siempre
                                this._slotContext = null;
                            }
                        }.bind(this),
                        // ERROR callback de validación de lote
                        function (oError, sHttpErrorMessage) {
                            oView.byId("idPluginPanel").setBusy(false);
                            var err = oError || sHttpErrorMessage;
                            sap.m.MessageToast.show(oBundle.getText("errorValidarLote", [err]));

                            // Solo limpiar input si viene del input superior
                            if (!this._slotContext) {
                                oInput.setValue("");
                                oInput.focus();
                            }
                            // Limpiar contexto siempre
                            this._slotContext = null;
                        }.bind(this)
                    );
                }.bind(this),
                // ERROR callback de validación de material
                function (oError, sHttpErrorMessage) {
                    oView.byId("idPluginPanel").setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorValidacionMaterial", [sHttpErrorMessage || ""]));
                    // Solo limpiar input si viene del input superior
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    // Limpiar contexto siempre
                    this._slotContext = null;
                }.bind(this)
            );
        },
        _formatLoteQty: function (vCantidad) {
            var n = parseFloat(vCantidad);
            return isNaN(n) ? "" : n.toFixed(2);
        },
        /**
         * Filtra el array de slots para visualización: los slots cuyo material no coincide con
         * el material activo de la orden se muestran como vacíos en la tabla, pero su valor se
         * preserva intacto en el CV (no se sobreescribe en operaciones de escritura).
         * @param {Array} aAllSlots - Array completo de slots con sus valores reales del CV
         * @returns {Array} Copia mapeada donde los slots de otro material tienen value=""
         */
        _filterSlotsForDisplay: function (aAllSlots) {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            var sMatOrder = oOrderSummaryModel
                ? (oOrderSummaryModel.getProperty("/material") || "").toUpperCase()
                : "";
            // Mostrar solo slots ocupados del material activo (lista dinámica, sin filas vacías)
            return aAllSlots.filter(function (slot) {
                if (!slot.value || slot.value.trim() === "") { return false; }
                if (!sMatOrder) { return true; }
                var sMat = (slot.value.split('!')[0] || "").toUpperCase();
                return sMat === sMatOrder;
            });
        },
        /**
         * Refresca el modelo de la tabla consultando los customValues del puesto de trabajo desde el backend.
         * 
         * Este método garantiza que ANTES de cualquier operación de escritura (_ejecutarUpdate,
         * _procesarSlotValidado, onDeleteSlot), la tabla refleje el estado REAL del backend.
         * @returns {Promise<{slots: Array, customValues: Array}|null>} null si hubo error
         */
        _refreshSlotsFromBackend: function () {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oTable = oView.byId("idSlotTable");
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var sParams = {
                plant: oPODParams.PLANT_ID,
                workCenter: oPODParams.WORK_CENTER
            };

            // Preservar loteQty del modelo actual antes de sobreescribir
            var oCurrentModel = oTable.getModel();
            var aCurrentItems = (oCurrentModel && oCurrentModel.getProperty("/ITEMS")) || [];
            var oLoteDataMap = {};
            aCurrentItems.forEach(function (item) {
                if (item.value) {
                    var parts = item.value.split('!');
                    var key = parts.slice(0, 2).join('!').toUpperCase();
                    oLoteDataMap[key] = { loteQty: item.loteQty || "", loteUom: item.loteUom || "" };
                }
            });

            return this.getWorkCenterCustomValues(sParams, oSapApi).then(function (oData) {
                if (!oData || oData === "Error" || !oData.customValues) {
                    return null;
                }

                var aCustomValues = oData.customValues;
                // Lista dinámica: todos los slots del backend (ocupados y vacíos de eliminaciones previas)
                var aSlotsFixed = aCustomValues.filter(function (item) {
                    return item.attribute.startsWith("SLOT") &&
                        item.attribute !== "SLOTQTY" &&
                        item.attribute !== "SLOTTIPO";
                });

                // Restaurar loteQty y loteUom desde el modelo anterior (matching por material!lote)
                aSlotsFixed.forEach(function (slot) {
                    if (slot.value) {
                        var parts = slot.value.split('!');
                        var key = parts.slice(0, 2).join('!').toUpperCase();
                        var oData = oLoteDataMap[key] || {};
                        slot.loteQty = oData.loteQty || "";
                        slot.loteUom = oData.loteUom || "";
                    } else {
                        slot.loteQty = "";
                        slot.loteUom = "";
                    }
                });

                // Actualizar tabla con datos frescos (filtrar por material de la orden activa)
                var aSlotsDisplay = this._filterSlotsForDisplay(aSlotsFixed);
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aSlotsDisplay }));
                this._updateOrderSummaryScannedQty(aSlotsDisplay);

                // Resincronizar contador de secuencia
                var iSlotsConValor = aSlotsFixed.filter(function (s) {
                    return s.value && s.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                } else {
                    var maxSecuencia = Math.max.apply(null, aSlotsFixed
                        .filter(function (s) { return s.value; })
                        .map(function (s) {
                            var parts = (s.value || "").split('!');
                            return parseInt(parts[2] || 0);
                        })
                    );
                    this.iSecuenciaCounter = maxSecuencia;
                }

                return { slots: aSlotsFixed, customValues: aCustomValues, operationActivity: oData.operationActivity };
            }.bind(this));
        },
        /**
         * Asigna el barcode escaneado (desde input superior) al primer slot vacío.
         * FLUJO: _refreshSlotsFromBackend() → validar duplicados → asignar slot vacío → merge → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _ejecutarUpdate: function (sCantidadLote, sUom, sBarcodeIn) {
            this._enqueueWrite(this._ejecutarUpdateSerial.bind(this, sCantidadLote, sUom, sBarcodeIn));
        },
        _ejecutarUpdateSerial: function (sCantidadLote, sUom, sBarcodeIn) {
            const oView = this.getView();
            const oInput = oView.byId("scanInput");
            // Usar el barcode capturado antes de la validación async (evita race condition
            // si el input fue limpiado mientras se esperaba la respuesta del servidor).
            const sBarcode = (sBarcodeIn || oInput.getValue()).trim();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = oView.getModel("i18n").getResourceBundle();

            // Refrescar desde backend antes de operar para evitar datos stale
            return this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                const oTable = oView.byId("idSlotTable");
                // Usar el pool completo de slots (no el modelo de tabla que puede estar filtrado)
                const aItems = oRefresh.slots || [];

                // Extraer material!lote del barcode escaneado (ignorar secuencia si existe)
                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar si ya existe un item con el mismo material!lote (pool completo)
                const oExiste = aItems.find(function (Item) {
                    const valorItem = (Item.value || "").toString().trim().toUpperCase();
                    if (!valorItem) return false;
                    const partsItem = valorItem.split('!');
                    const materialLoteItem = partsItem.slice(0, 2).join('!');
                    return materialLoteItem === materialLoteEscaneado;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, oExiste.attribute]));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }

                // Buscar slot vacío existente (de eliminación previa) o crear uno nuevo dinámico
                const oEmptySlot = aItems.find(function (item) { return !item.value || item.value === ""; });
                this.iSecuenciaCounter++;
                if (oEmptySlot) {
                    // Reutilizar hueco dejado por eliminación anterior
                    oEmptySlot.value = sBarcode + "!" + this.iSecuenciaCounter;
                    oEmptySlot.loteQty = sCantidadLote || "";
                    oEmptySlot.loteUom = sUom || "";
                } else {
                    // Sin huecos disponibles: añadir nuevo slot al final
                    const sNextAttr = "SLOT" + this.iSecuenciaCounter.toString().padStart(3, "0");
                    aItems.push({
                        attribute: sNextAttr,
                        value: sBarcode + "!" + this.iSecuenciaCounter,
                        loteQty: sCantidadLote || "",
                        loteUom: sUom || ""
                    });
                }
                // Actualizar tabla (solo slots ocupados del material activo)
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: this._filterSlotsForDisplay(aItems) }));
                this._updateOrderSummaryScannedQty(this._filterSlotsForDisplay(aItems));

                oInput.setValue("");
                oInput.focus();

                // Construir editados sobre datos COMPLETOS (preserva lotes de otro material en CV)
                const aEdited = [
                    ...aItems.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
                ];

                // Merge con customValues frescos (ya obtenidos en el refresh, sin doble consulta)
                const aOriginal = oRefresh.customValues;
                const editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                const sMaterialLote = materialLoteEscaneado || "";
                const oSapApi = this.getPublicApiRestDataSourceUri();
                return this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLote,
                    inOperationActivity: oRefresh.operationActivity
                }, oSapApi).then(function () {
                    this._notificarSlotActualizado();
                }.bind(this)).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                    this.onGetCustomValues();
                }.bind(this));
            }.bind(this));
        },
        onScanSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
            } else {
                if (oEvent.getParameter("text")) {
                    this.oScanInput.setValue(oEvent.getParameter("text"));
                    this.onBarcodeSubmit();
                } else {
                    this.oScanInput.setValue('');
                }
            }
        },
        onScanError: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            sap.m.MessageToast.show(oBundle.getText("scanFailed", [oEvent]), { duration: 1000 });
        },
        onScanLiveupdate: function (oEvent) {
            if (this._oScanDebounceTimer) {
                clearTimeout(this._oScanDebounceTimer);
            }
            this._oScanDebounceTimer = setTimeout(function () {
                this._oScanDebounceTimer = null;
                this.onBarcodeSubmit();
            }.bind(this), 500);
        },
        /**
         * Elimina un lote de la tabla y recorre los posteriores hacia arriba.
         * 
         * FLUJO: Capturar valor a eliminar → _refreshSlotsFromBackend() → buscar valor en datos
         *        frescos → eliminar y recorrer → renumerar secuencias → merge → POST
         * 
         * NOTA IMPORTANTE: Se captura el VALUE del slot (no el índice DOM) ANTES del refresh,
         *   porque al refrescar la tabla el DOM se reconstruye y las referencias de fila se invalidan.
         *   Luego se busca ese value en los datos frescos. Si el lote ya no existe (fue eliminado
         *   externamente por consumo), se muestra "loteYaEliminado" y no se intenta borrar.
         */
        onDeleteSlot: function (oEvent) {
            const oTable = this.byId("idSlotTable");
            const oModel = oTable.getModel();

            // Capturar el valor del slot a eliminar ANTES del refresh (la ref DOM puede cambiar)
            const oItem = oEvent.getSource().getParent();
            const iCurrentIndex = oTable.indexOfItem(oItem);
            if (iCurrentIndex === -1) {
                return;
            }
            const aCurrentSlots = oModel.getProperty("/ITEMS") || [];
            const sValueToDelete = ((aCurrentSlots[iCurrentIndex] && aCurrentSlots[iCurrentIndex].value) || "").trim();
            if (!sValueToDelete) {
                return;
            }

            this._enqueueWrite(this._eliminarSlotSerial.bind(this, sValueToDelete));
        },
        _eliminarSlotSerial: function (sValueToDelete) {
            const oTable = this.byId("idSlotTable");
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            // Refrescar desde backend antes de operar para evitar datos stale
            return this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                // Usar el pool completo de slots (no el modelo de tabla que puede estar filtrado)
                var aSlots = oRefresh.slots || [];

                // Buscar el slot con el valor a eliminar en datos frescos
                const iIndex = aSlots.findIndex(function (s) {
                    return (s.value || "").trim() === sValueToDelete;
                });

                if (iIndex === -1) {
                    // Ya fue eliminado externamente
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                // Eliminar y recorrer hacia arriba
                for (var i = iIndex; i < aSlots.length - 1; i++) {
                    aSlots[i].value = aSlots[i + 1].value;
                    aSlots[i].loteQty = aSlots[i + 1].loteQty;
                    aSlots[i].loteUom = aSlots[i + 1].loteUom;
                }
                aSlots[aSlots.length - 1].value = "";
                aSlots[aSlots.length - 1].loteQty = "";
                aSlots[aSlots.length - 1].loteUom = "";

                // Renumerar secuencia
                var iNuevaSecuencia = 0;
                aSlots.forEach(function (slot) {
                    var sValorActual = ((slot && slot.value) || "").toString().trim();
                    if (!sValorActual) return;
                    var aPartes = sValorActual.split('!');
                    if (aPartes.length >= 2) {
                        iNuevaSecuencia++;
                        slot.value = aPartes.slice(0, 2).join('!') + "!" + iNuevaSecuencia;
                    }
                });
                this.iSecuenciaCounter = iNuevaSecuencia;

                // Actualizar tabla con vista filtrada (lotes de otro material permanecen ocultos)
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: this._filterSlotsForDisplay(aSlots) }));
                this._updateOrderSummaryScannedQty(this._filterSlotsForDisplay(aSlots));

                sap.m.MessageToast.show(oBundle.getText("loteEliminado"));

                // Construir editados sobre datos COMPLETOS (preserva lotes de otro material en CV)
                var aEdited = aSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; });

                // Merge con customValues frescos (ya obtenidos en el refresh)
                var aOriginal = oRefresh.customValues;
                var editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                var aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                var partsDeleted = sValueToDelete.split('!');
                var sMaterialLoteDeleted = partsDeleted.slice(0, 2).join('!');
                var oSapApi = this.getPublicApiRestDataSourceUri();
                return this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLoteDeleted,
                    inOperationActivity: oRefresh.operationActivity
                }, oSapApi).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("loteActualizadoAntesEliminar"));
                }).catch(function () {
                    sap.m.MessageBox.error(oBundle.getText("errorActualizarTrasEliminar"));
                    this.onGetCustomValues();
                }.bind(this));
            }.bind(this));
        },
        /**
         * Callback del escáner por fila (botón de escaneo en cada ColumnListItem).
         * Valida formato del barcode, captura el atributo del slot destino (ej: "SLOT005")
         * y lanza la validación de material+lote. Al pasar, continúa en _procesarSlotValidado.
         * 
         * NOTA: Se guarda slotAttribute (no referencia DOM) en _slotContext porque tras el
         *   refresh del backend el DOM se reconstruye y la referencia de oEvent sería stale.
         */
        onScanSlotSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
                return;
            }
            const sBarcode = (oEvent.getParameter("text") || "").trim();
            if (!sBarcode) { return; }

            if (this._bloquearEscaneoInspeccion()) { return; }

            const parts = sBarcode.toUpperCase().split('!');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                return;
            }

            const sMaterial = parts[0].trim();
            const sLote = parts[1].trim();

            // Capturar atributo del slot antes de validación (la referencia DOM puede cambiar tras refresh)
            const oButton = oEvent.getSource();
            const oSlotItem = oButton.getParent();
            const oTable = this.byId("idSlotTable");
            const iSlotIndex = oTable.indexOfItem(oSlotItem);
            const oSlotModel = oTable.getModel();
            const aCurrentSlots = (oSlotModel && oSlotModel.getProperty("/ITEMS")) || [];
            const sSlotAttribute = (iSlotIndex >= 0 && aCurrentSlots[iSlotIndex]) ? aCurrentSlots[iSlotIndex].attribute : null;

            // Guarda contexto para actualizar la fila cuando ambas validaciones pasen
            this._slotContext = { oEvent: oEvent, sBarcode: sBarcode, loteExtraido: sLote, slotAttribute: sSlotAttribute };

            // Reutiliza la validación combinada
            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Procesa la asignación de un barcode validado a un slot específico (escaneo por fila).
         * 
         * FLUJO: _refreshSlotsFromBackend() → localizar slot por atributo → validar duplicados
         *        → asignar valor+secuencia → merge con customValues frescos → POST
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         */
        _procesarSlotValidado: function (sCantidadLote, sUom) {
            this._enqueueWrite(this._procesarSlotValidadoSerial.bind(this, sCantidadLote, sUom, this._slotContext));
        },
        _procesarSlotValidadoSerial: function (sCantidadLote, sUom, oSlotContext) {
            if (!oSlotContext) {
                const oBundle = this.getView().getModel("i18n").getResourceBundle();
                console.error(oBundle.getText("noContextoSlot"));
                return;
            }

            const { sBarcode, slotAttribute } = oSlotContext;
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());

            // Refrescar desde backend antes de operar para evitar datos stale
            return this._refreshSlotsFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const oTable = this.byId("idSlotTable");
                // Usar el pool completo de slots (no el modelo de tabla que puede estar filtrado)
                const aSlots = oRefresh.slots || [];

                // Encontrar el slot destino por atributo (no por referencia DOM que puede ser stale)
                const iIndex = aSlots.findIndex(function (s) { return s.attribute === slotAttribute; });
                if (iIndex === -1 || !aSlots[iIndex]) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                const sNormalizado = sBarcode.toUpperCase();
                const partsEscaneado = sNormalizado.split('!');
                const materialLoteEscaneado = partsEscaneado.slice(0, 2).join('!');

                // Buscar duplicados en datos frescos
                const sExiste = aSlots.find(function (slot, idx) {
                    if (idx === iIndex) return false;
                    const valorSlot = (slot.value || "").toString().trim().toUpperCase();
                    if (!valorSlot) return false;
                    const partsSlot = valorSlot.split('!');
                    const materialLoteSlot = partsSlot.slice(0, 2).join('!');
                    return materialLoteSlot === materialLoteEscaneado;
                });

                if (sExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode, sExiste.attribute]));
                    this._slotContext = null;
                    return;
                }

                // Si el valor ya es el mismo en esa fila, no actualizar
                const valorActual = (aSlots[iIndex].value || "").toString().trim().toUpperCase();
                if (valorActual) {
                    const partsActual = valorActual.split('!');
                    const materialLoteActual = partsActual.slice(0, 2).join('!');
                    if (materialLoteActual === materialLoteEscaneado) {
                        sap.m.MessageToast.show(oBundle.getText("sinCambios"));
                        this._slotContext = null;
                        return;
                    }
                }

                const iSlotsConValor = aSlots.filter(function (slot) {
                    return slot.value && slot.value.trim() !== "";
                }).length;
                if (iSlotsConValor === 0) {
                    this.iSecuenciaCounter = 0;
                }

                this.iSecuenciaCounter++;
                aSlots[iIndex].value = sBarcode + "!" + this.iSecuenciaCounter;
                aSlots[iIndex].loteQty = sCantidadLote || "";
                aSlots[iIndex].loteUom = sUom || "";
                // Actualizar tabla con vista filtrada (lotes de otro material permanecen ocultos)
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: this._filterSlotsForDisplay(aSlots) }));
                this._updateOrderSummaryScannedQty(this._filterSlotsForDisplay(aSlots));

                const oView = this.getView();

                const aEdited = [
                    ...aSlots.map(function (slot) { return { attribute: slot.attribute, value: slot.value }; })
                ];

                // Merge con customValues frescos (ya obtenidos en el refresh)
                const aOriginal = oRefresh.customValues;
                const editedMap = {};
                aEdited.forEach(function (item) { editedMap[item.attribute] = item.value; });

                const aCustomValuesFinal = aOriginal.map(function (item) {
                    return {
                        attribute: item.attribute,
                        value: editedMap.hasOwnProperty(item.attribute) ? editedMap[item.attribute] : item.value
                    };
                });

                for (var key in editedMap) {
                    if (!aCustomValuesFinal.find(function (i) { return i.attribute === key; })) {
                        aCustomValuesFinal.push({ attribute: key, value: editedMap[key] });
                    }
                }

                const sMaterialLote = materialLoteEscaneado || "";
                const oSapApi = this.getPublicApiRestDataSourceUri();
                return this.setCustomValuesPp({
                    inCustomValues: aCustomValuesFinal,
                    inPlant: oPODParams.PLANT_ID,
                    inWorkCenter: oPODParams.WORK_CENTER,
                    inMaterialLote: sMaterialLote,
                    inOperationActivity: oRefresh.operationActivity
                }, oSapApi).then(function () {
                    this._notificarSlotActualizado();
                    this._slotContext = null;
                }.bind(this)).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                    this._slotContext = null;
                    this.onGetCustomValues();
                }.bind(this));
            }.bind(this));
        },
        onBeforeRenderingPlugin: function () {
            // Inicializar gOperationPhase desde POD para capturar estado inicial
            var oPodSelectionModel = this.getPodSelectionModel();
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                var sStatus = oPodSelectionModel.selectedPhaseData.status || "";
                gOperationPhase = {
                    status: sStatus
                };
            }

            this.subscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        onPhaseSelectionEventCustom: function (sChannelId, sEventId, oData) {
            if (this.isEventFiredByThisPlugin(oData)) {
                return;
            }
            gOperationPhase = oData;
            this._bAvisoInspeccionMostrado = false;
            this.onGetCustomValues();

        },
        _getCurrentOperationStatus: function () {
            var oPodSelectionModel = this.getPodSelectionModel();
            var sCurrentStatus = "";


            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                sCurrentStatus = oPodSelectionModel.selectedPhaseData.status || "";
            }

            if (!sCurrentStatus) {
                var operation = (oPodSelectionModel && typeof oPodSelectionModel.getOperation === "function")
                    ? (oPodSelectionModel.getOperation() && oPodSelectionModel.getOperation().operation)
                    : null;
                if (!operation && gOperationPhase && gOperationPhase.operation) {
                    operation = gOperationPhase.operation.operation || gOperationPhase.operation;
                }
                if (operation) {
                    sCurrentStatus = operation.status || operation.operationStatus || "";
                }
            }

            if (!sCurrentStatus && gOperationPhase) {
                sCurrentStatus = gOperationPhase.status || "";
            }

            return sCurrentStatus;
        },
        isSubscribingToNotifications: function () {
            var bNotificationsEnabled = true;
            return bNotificationsEnabled;
        },
        getCustomNotificationEvents: function (sTopic) {
            //return ["template"];
        },
        getNotificationMessageHandler: function (sTopic) {
            //if (sTopic === "template") {
            //    return this._handleNotificationMessage;
            //}
            return null;
        },
        _handleNotificationMessage: function (oMsg) {

            var sMessage = "Message not found in payload 'message' property";
            if (oMsg && oMsg.parameters && oMsg.parameters.length > 0) {
                for (var i = 0; i < oMsg.parameters.length; i++) {

                    switch (oMsg.parameters[i].name) {
                        case "template":

                            break;
                        case "template2":
                            break;
                    }
                }
            }
        },
        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);

            this.unsubscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        summarizeByErpSequence: function (aComponents) {
            var mGroups = {};
            var aOrder = [];
            aComponents.forEach(function (oComp) {
                var sKey = oComp.erpSequence !== undefined && oComp.erpSequence !== null
                    ? String(oComp.erpSequence)
                    : String(oComp.sequence);
                if (!mGroups[sKey]) {
                    mGroups[sKey] = {
                        erpSequence: oComp.erpSequence,
                        sequence: oComp.sequence,
                        material: oComp.material,
                        unitOfMeasure: oComp.unitOfMeasure,
                        componentType: oComp.componentType,
                        assemblyOperationActivity: oComp.assemblyOperationActivity,
                        reservationOrderNumber: oComp.reservationOrderNumber,
                        quantity: 0,
                        totalQuantity: 0
                    };
                    aOrder.push(sKey);
                }
                mGroups[sKey].quantity += Number(oComp.quantity || 0);
                mGroups[sKey].totalQuantity += Number(oComp.totalQuantity || 0);
            });
            return aOrder.map(function (sKey) { return mGroups[sKey]; });
        },
        setOrderSummary: function () {
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const order = oPODParams.ORDER_ID;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oParams = {
                plant: oPODParams.PLANT_ID,
                bom: oPODParams.BOM_ID,
                type: "SHOP_ORDER"
            };

            // La tabla de lotes consumidos no aplica a la planta 1301
            const bMostrarConsumos = oPODParams.PLANT_ID !== "1301";
            this._bConsumidaCargada = false;
            this._bAvisoCubiertaMostrado = false;
            this.getView().getModel("orderSummary").setProperty("/mostrarConsumos", bMostrarConsumos);
            if (!bMostrarConsumos) {
                this._iConsumosReqId++; // invalida respuestas en vuelo
                this._setConsumos([]);
            }

            this.getOrderSummary(oParams, oSapApi)
                .then(function (data) {
                    const oBomData = Array.isArray(data) ? data[0] : data;
                    const aComponents = (oBomData && Array.isArray(oBomData.components)) ? oBomData.components : [];
                    const aNormalComponents = aComponents.filter(function (oComp) {
                        return oComp && oComp.componentType === "NORMAL";
                    });

                    // Guardar para validación de lote al escanear
                    this._aBomNormalComponents = aNormalComponents;

                    if (!aNormalComponents.length) {
                        console.warn("[OrderSummary] No se encontró componente NORMAL en BOMS", oBomData);
                        return;
                    }

                    const aGrouped = this.summarizeByErpSequence(aNormalComponents);
                    const oPrimerGrupo = aGrouped[0] || {};
                    const oPrimerComponente = aNormalComponents[0] || {};
                    const oOrderSummaryModel = this.getView().getModel("orderSummary");
                    const sMaterial = (oPrimerGrupo.material && oPrimerGrupo.material.material) || "";
                    const sUom = oPrimerGrupo.unitOfMeasure || "";
                    const sBatch = oPrimerComponente.batchNumber || "";
                    const nCantidadNecesaria = aGrouped.reduce(function (nSum, oGrupo) {
                        return nSum + Number(oGrupo.totalQuantity || 0);
                    }, 0);

                    oOrderSummaryModel.setProperty("/lote", sBatch);
                    oOrderSummaryModel.setProperty("/material", sMaterial);
                    oOrderSummaryModel.setProperty("/cantidadNecesaria", nCantidadNecesaria);
                    oOrderSummaryModel.setProperty("/unidadMedida", sUom);

                    // Lotes consumidos en paralelo; resuelve con el total o null (nunca rechaza)
                    var pConsumos = bMostrarConsumos
                        ? this._loadConsumos(sMaterial, oPODParams, oSapApi)
                        : Promise.resolve(null);

                    var pHeader = this.getHeaderMaterial({ material: sMaterial, plant: oPODParams.PLANT_ID }, oSapApi)
                        .then(function (headerData) {
                            const oHeader = Array.isArray(headerData) ? headerData[0] : headerData;
                            const sDescripcion = (oHeader && oHeader.description) || "";
                            oOrderSummaryModel.setProperty("/descripcion", sDescripcion);
                            // Consulta de cantidad consumida (Goods Issue); fallo silencioso
                            return this.getGoodsIssuesSummary({
                                plant: oPODParams.PLANT_ID,
                                order: oPODParams.ORDER_ID,
                                sfc: oPODParams.SFC,
                                operationActivity: oPODParams.OPERATION_ACTIVITY,
                                stepId: oPODParams.STEP_ID
                            }, oSapApi).catch(function () { return null; });
                        }.bind(this))
                        .then(function (oGoodsData) {
                            var aLineItems = (oGoodsData && Array.isArray(oGoodsData.lineItems)) ? oGoodsData.lineItems : [];
                            var oConsumoMap = {};
                            aLineItems.forEach(function (oItem) {
                                var sMat = (oItem.materialId && oItem.materialId.material) || "";
                                var nConsumo = (oItem.consumedQuantity && oItem.consumedQuantity.value) || 0;
                                if (sMat) { oConsumoMap[sMat.toUpperCase()] = nConsumo; }
                            });
                            oOrderSummaryModel.setProperty("/cantidadConsumida",
                                oConsumoMap[(oOrderSummaryModel.getProperty("/material") || "").toUpperCase()] || 0);
                            this._bConsumidaCargada = true;
                            this._updateCantidadEnProceso();
                            this._avisarCantidadCubierta();
                        }.bind(this))
                        .catch(function (error) {
                            console.error("[OrderSummary Test] Error:", error);
                            sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", [sMaterial]));
                        }.bind(this));

                    // Suma de verificación: lotes consumidos vs cantidad consumida de cabecera
                    Promise.all([pHeader, pConsumos]).then(function (aRes) {
                        var nLotes = aRes[1];
                        if (nLotes === null) { return; }
                        var nCabecera = Number(oOrderSummaryModel.getProperty("/cantidadConsumida")) || 0;
                        if (Math.abs(nCabecera - nLotes) > 0.001) {
                            console.warn("[Consumos] Diferencia entre cantidad consumida (cabecera) y suma de lotes consumidos:",
                                { cabecera: nCabecera, lotes: nLotes });
                        }
                    });

                    this._updateOrderSummaryScannedQty();
                }.bind(this))
                .catch(function (error) {
                    console.error("[OrderSummary Test] Error:", error);
                    sap.m.MessageToast.show(oBundle.getText("errorObtenerBom", [order]));
                }.bind(this));
        },
        /**
         * Carga los lotes consumidos (goodsIssues) del SFC/material, recorriendo todas las páginas.
         * Fallo silencioso: tabla vacía. Ignora respuestas obsoletas (_iConsumosReqId).
         * @returns {Promise<number|null>} total consumido, o null si falló/obsoleto
         */
        _loadConsumos: function (sMaterial, oPODParams, oSapApi) {
            var iReqId = ++this._iConsumosReqId;
            if (!sMaterial) {
                this._setConsumos([]);
                return Promise.resolve(null);
            }
            var oBase = {
                plant: oPODParams.PLANT_ID,
                material: sMaterial,
                materialVersion: "ERP001",
                sfc: oPODParams.SFC,
                size: 500
            };
            var fnPage = function (iPage) {
                return this.getGoodsIssueSummaryMaterial(Object.assign({}, oBase, { page: iPage }), oSapApi);
            }.bind(this);

            return this.getGoodsIssueSummaryMaterial(oBase, oSapApi).then(function (oFirst) {
                var aPromises = [Promise.resolve(oFirst)];
                var iTotalPages = (oFirst && oFirst.totalPages) || 1;
                for (var p = 1; p < iTotalPages; p++) {
                    aPromises.push(fnPage(p));
                }
                return Promise.all(aPromises);
            }).then(function (aPages) {
                if (iReqId !== this._iConsumosReqId) { return null; }
                var aAll = [];
                aPages.forEach(function (oPage) {
                    aAll = aAll.concat((oPage && Array.isArray(oPage.content)) ? oPage.content : []);
                });
                return this._setConsumos(aAll);
            }.bind(this)).catch(function (oErr) {
                console.error("[Consumos] Error al obtener lotes consumidos:", oErr);
                if (iReqId === this._iConsumosReqId) { this._setConsumos([]); }
                return null;
            }.bind(this));
        },
        /**
         * Filtra (GI + POSTED_TO_TARGET_SYS), agrupa por material + lote + UOM (suma cantidades),
         * ordena por el posting más reciente de cada lote (desc) y actualiza el modelo "consumos".
         * @returns {number} total consumido
         */
        _setConsumos: function (aContent) {
            var aPostings = (aContent || []).filter(function (oGi) {
                return oGi && oGi.postingType === "GI" && oGi.postingStatus === "POSTED_TO_TARGET_SYS";
            });
            var oGroups = {};
            var aGroups = [];
            aPostings.forEach(function (oGi) {
                var oQty = oGi.quantityInBaseUnit || {};
                var sMaterial = oGi.material || "";
                var sBatch = oGi.batchNumber || "";
                var sUom = oQty.internalUnitOfMeasure || "";
                var sKey = [sMaterial, sBatch, sUom].map(function (s) {
                    return String(s).trim().toUpperCase();
                }).join("|");
                var nTime = new Date(oGi.postingDateTime || 0).getTime() || 0;
                var oGroup = oGroups[sKey];
                if (!oGroup) {
                    oGroup = oGroups[sKey] = {
                        batchNumber: sBatch,
                        users: [],
                        material: sMaterial,
                        quantity: 0,
                        uom: sUom,
                        lastTime: nTime
                    };
                    aGroups.push(oGroup);
                }
                oGroup.quantity += Number(oQty.value) || 0;
                oGroup.lastTime = Math.max(oGroup.lastTime, nTime);
                if (oGi.postedBy && oGroup.users.indexOf(oGi.postedBy) === -1) {
                    oGroup.users.push(oGi.postedBy);
                }
            });
            var aItems = aGroups.sort(function (a, b) {
                return b.lastTime - a.lastTime;
            }).map(function (oGroup) {
                return {
                    batchNumber: oGroup.batchNumber,
                    postedBy: oGroup.users.join(", "),
                    material: oGroup.material,
                    quantity: Number(oGroup.quantity.toFixed(3)),
                    uom: oGroup.uom
                };
            });
            // Total sobre los postings filtrados (idéntico al cálculo previo a la agrupación)
            var nTotal = Number(aPostings.reduce(function (n, oGi) {
                return n + (Number((oGi.quantityInBaseUnit || {}).value) || 0);
            }, 0).toFixed(3));
            var sUom = aItems.length ? aItems[0].uom : "";
            this.getView().getModel("consumos").setData({ ITEMS: aItems, total: nTotal, uom: sUom });
            this.getView().getModel("orderSummary").setProperty("/cantidadConsumidaLotes", nTotal);
            return nTotal;
        },
        _updateOrderSummaryScannedQty: function (aItems) {
            const oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) {
                return;
            }

            let aSourceItems = aItems;
            if (!Array.isArray(aSourceItems)) {
                const oTable = this.byId("idSlotTable");
                const oTableModel = oTable && oTable.getModel();
                aSourceItems = (oTableModel && oTableModel.getProperty("/ITEMS")) || [];
            }

            const nScannedQty = aSourceItems.reduce(function (nTotal, oItem) {
                const nQty = parseFloat(oItem && oItem.loteQty);
                return nTotal + (isNaN(nQty) ? 0 : nQty);
            }, 0);

            oOrderSummaryModel.setProperty("/cantidadEscaneada", Number(nScannedQty.toFixed(2)));
            this._updateCantidadEnProceso();
        },
        /**
         * Cantidad en proceso = consumida (Goods Issue) + escaneada; solo informativa para el operador.
         */
        _updateCantidadEnProceso: function () {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            var nTotal = (parseFloat(oOrderSummaryModel.getProperty("/cantidadConsumida")) || 0)
                + (parseFloat(oOrderSummaryModel.getProperty("/cantidadEscaneada")) || 0);
            oOrderSummaryModel.setProperty("/cantidadEnProceso", Number(nTotal.toFixed(3)));
            this._updateScanInputEnabled();
        },
        /**
         * Inhabilita el input de escaneo cuando la cantidad requerida ya está cubierta o la operación es de inspección.
         */
        _updateScanInputEnabled: function () {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            oOrderSummaryModel.setProperty("/scanHabilitado", !this._getCantidadCubiertaInfo().bCubierta && !this._esOperacionInspeccion());
        },
        /**
         * Guarda el centro de trabajo de la operación (workCenter.workCenter del Operation API).
         */
        _actualizarCentroOperacion: function (oData) {
            var oWc = oData && oData.workCenter;
            this._sCentroOperacion = (((oWc && oWc.workCenter) || "") + "").trim().toUpperCase();
            this._updateScanInputEnabled();
        },
        /**
         * Centro de trabajo de la operación; si aún no se cargó el Operation API usa el del POD.
         */
        _getCentroOperacion: function () {
            if (this._sCentroOperacion) { return this._sCentroOperacion; }
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            return (((oPODParams && oPODParams.WORK_CENTER) || "") + "").trim().toUpperCase();
        },
        _esOperacionInspeccion: function () {
            return this._getCentroOperacion().indexOf("INS") === 0;
        },
        /**
         * @returns {boolean} true si la operación es de inspección (y muestra la advertencia)
         */
        _bloquearEscaneoInspeccion: function () {
            if (!this._esOperacionInspeccion()) { return false; }
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            MessageBox.warning(oBundle.getText("operacionInspeccionNoEscanear", [this._getCentroOperacion()]));
            return true;
        },
        /**
         * Al abrir el plugin avisa una sola vez si la operación es de inspección.
         */
        _avisarOperacionInspeccion: function () {
            if (!this._esOperacionInspeccion()) {
                this._bAvisoInspeccionMostrado = false;
                return;
            }
            if (this._bAvisoInspeccionMostrado) { return; }
            this._bAvisoInspeccionMostrado = true;
            this._bloquearEscaneoInspeccion();
        },
        /**
         * Compara la cantidad en proceso contra la requerida por la orden.
         * @returns {{nNecesaria: number, nTotal: number, bCubierta: boolean}}
         */
        _getCantidadCubiertaInfo: function () {
            var oOrderSummaryModel = this.getView().getModel("orderSummary");
            var nNecesaria = parseFloat(oOrderSummaryModel.getProperty("/cantidadNecesaria")) || 0;
            var nTotal = parseFloat(oOrderSummaryModel.getProperty("/cantidadEnProceso")) || 0;
            // mostrarConsumos es false en la planta 1301, donde no aplica la validación
            var bAplica = oOrderSummaryModel.getProperty("/mostrarConsumos") === true;
            return { nNecesaria: nNecesaria, nTotal: nTotal, bCubierta: bAplica && nNecesaria > 0 && nTotal >= nNecesaria };
        },
        /**
         * Al abrir el plugin avisa una sola vez si la orden ya está cubierta; espera a la cantidad consumida
         * (Goods Issue) y se invoca también al cargar los slots, que pueden llegar después.
         */
        _avisarCantidadCubierta: function () {
            if (!this._bConsumidaCargada) { return; }
            var oCubierta = this._getCantidadCubiertaInfo();
            if (!oCubierta.bCubierta) {
                this._bAvisoCubiertaMostrado = false;
                return;
            }
            if (this._bAvisoCubiertaMostrado) { return; }
            this._bAvisoCubiertaMostrado = true;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            MessageBox.warning(oBundle.getText("cantidadOrdenCubiertaAviso", [oCubierta.nNecesaria, oCubierta.nTotal]));
        },
        /**
         * Aviso tras guardar un slot: si la orden ya quedó cubierta indica que no hay que montar más lotes.
         */
        _notificarSlotActualizado: function () {
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            var oCubierta = this._getCantidadCubiertaInfo();
            if (oCubierta.bCubierta) {
                this._bAvisoCubiertaMostrado = true;
                sap.m.MessageToast.show(
                    oBundle.getText("cantidadOrdenCubiertaAviso", [oCubierta.nNecesaria, oCubierta.nTotal]),
                    { duration: 5000 });
                return;
            }
            sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
        },
        getHeaderMaterial: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.HEADER_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getGoodsIssuesSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.GOODSISSUES_SUMMARY, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getGoodsIssueSummaryMaterial: function (sParams, oSapApi) {
            return new Promise(function (resolve, reject) {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.GOODSISSUES_SUMMARY_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this), function (oRes) {
                    reject(oRes);
                }.bind(this));
            }.bind(this));
        },
        getOrderSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.BOMS, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        /**
         * Lee los customValues de la Actividad de Operación (OPERATION_ACTIVITIES).
         * Devuelve { customValues, operationActivity } o "Error"; operationActivity es el registro leído
         * (plant, operation, version) que debe usarse al escribir.
         */
        getWorkCenterCustomValues: function (sParams, oSapApi) {
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            return new Promise(function (resolve) {
                var oQueryParams = {
                    plant: sParams.plant || oPODParams.PLANT_ID,
                    operation: oPODParams.OPERATION_ACTIVITY
                };
                this.ajaxGetRequest(oSapApi + this.ApiPaths.OPERATION_ACTIVITIES, oQueryParams, function (oRes) {
                    var aContent = (oRes && oRes.content) || [];
                    var oData = aContent[0];
                    if (!oData) {
                        resolve("Error");
                        return;
                    }
                    this._actualizarCentroOperacion(oData);
                    resolve({ customValues: oData.customValues || [], operationActivity: oData });
                }.bind(this),
                function () {
                    resolve("Error");
                }.bind(this));
            }.bind(this));
        },
        /**
         * Ejecuta fnTask después de las escrituras pendientes; la siguiente espera a que fnTask termine.
         * @param {Function} fnTask - debe devolver una promesa que termine tras el POST
         */
        _enqueueWrite: function (fnTask) {
            var pRun = this._pWriteQueue.then(fnTask);
            this._pWriteQueue = pRun.catch(function () { });
            return pRun;
        },
        /**
         * Persiste customValues en la Actividad de Operación usando putBatchSlotOperationActivity.
         * @param {Object} oParams - { inCustomValues: Array, inOperationActivity: { plant, operation, version } }
         * @returns {Promise} rechaza si falta la actividad de operación o si falla el POST
         */
        setCustomValuesPp: function (oParams, oSapApi) {
            var oOAData = oParams.inOperationActivity;
            if (!oOAData || !oOAData.operation) {
                return Promise.reject("operationActivity");
            }
            var oPayload = {
                inData: [{
                    plant: oOAData.plant,
                    operation: oOAData.operation,
                    version: oOAData.version || "",
                    customValues: oParams.inCustomValues
                }]
            };
            return new Promise(function (resolve, reject) {
                this.ajaxPostRequest(oSapApi + this.ApiPaths.putBatchSlotOperationActivity, oPayload, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                function (oError) {
                    reject(oError);
                }.bind(this));
            }.bind(this));
        },
    });
});